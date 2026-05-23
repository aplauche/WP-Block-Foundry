/**
 * Block Foundry — Gutenberg Sidebar Panel
 *
 * Registers a PluginSidebar in the block editor that lets users describe
 * a custom block, sends the prompt server-side to Claude, previews the
 * generated code, deploys it, and refreshes the block store so it
 * appears in the inserter instantly.
 */

import { registerPlugin } from '@wordpress/plugins';
import { PluginSidebar, PluginSidebarMoreMenuItem } from '@wordpress/editor';
import { useState, useCallback, useRef, useEffect } from '@wordpress/element';
import {
	Panel,
	PanelBody,
	PanelRow,
	TextareaControl,
	Button,
	Spinner,
	Notice,
	TabPanel,
} from '@wordpress/components';
import {
	getBlockType,
	unregisterBlockType,
	unstable__bootstrapServerSideBlockDefinitions,
} from '@wordpress/blocks';
import apiFetch from '@wordpress/api-fetch';

import './editor.scss';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

// Dashicon slug — rendered by the registerPlugin / PluginSidebar icon props.
const ICON = 'hammer';

/**
 * Feature flag — hot-load newly deployed blocks into the running editor.
 *
 * When TRUE: deploying a block dynamically registers it in the live editor so
 * it appears in the inserter immediately, no page reload required.
 *
 * When FALSE: we skip the hot-load and just nudge the user to click
 * "Reload Editor" (the always-reliable path, since PHP re-enqueues every
 * block's assets on the next page load).
 *
 * The hot-load path depends on wp.blocks.unstable__bootstrapServerSideBlockDefinitions,
 * an UNSTABLE WordPress API. It has been stable in practice for years, but if a
 * future WP release breaks it, flip this to false. The "Reload Editor" button
 * stays available either way, and any hot-load failure falls back to it
 * automatically.
 */
const ENABLE_HOT_RELOAD = true;

/**
 * Append a <script> tag and resolve once it has loaded. Used to pull a freshly
 * deployed block's index.js into the running editor so its registerBlockType()
 * call executes without a page reload.
 *
 * @param {string} src Fully-qualified script URL.
 * @return {Promise<void>} Resolves on load, rejects on error.
 */
const injectScript = ( src ) =>
	new Promise( ( resolve, reject ) => {
		const tag = document.createElement( 'script' );
		tag.src = src;
		tag.onload = resolve;
		tag.onerror = () => reject( new Error( 'Failed to load ' + src ) );
		document.head.appendChild( tag );
	} );

/**
 * Append a <link rel="stylesheet"> tag. Fire-and-forget — block styles aren't
 * required for registration, so callers don't await this.
 *
 * @param {string} href Fully-qualified stylesheet URL.
 */
const injectStyle = ( href ) => {
	const tag = document.createElement( 'link' );
	tag.rel = 'stylesheet';
	tag.href = href;
	document.head.appendChild( tag );
};

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

const BlockFoundryPanel = () => {
	const [ prompt, setPrompt ]             = useState( '' );
	const [ isLoading, setIsLoading ]       = useState( false );
	const [ isDeploying, setIsDeploying ]   = useState( false );
	const [ response, setResponse ]         = useState( null );
	const [ parsedBlock, setParsedBlock ]   = useState( null );
	const [ notice, setNotice ]             = useState( null );
	const [ deployedBlocks, setDeployed ]   = useState( [] );
	const [ activeTab, setActiveTab ]       = useState( 'generate' );
	const [ elapsed, setElapsed ]           = useState( 0 );
	const textareaRef                       = useRef();
	const timerRef                          = useRef();

	/* ---- Fetch deployed blocks on mount ---- */
	useEffect( () => {
		fetchDeployedBlocks();
	}, [] );

	/* ---- Clear the elapsed-time interval if we unmount mid-generation ---- */
	useEffect( () => () => clearInterval( timerRef.current ), [] );

	const fetchDeployedBlocks = async () => {
		try {
			const blocks = await apiFetch( {
				path: '/block-foundry/v1/blocks',
			} );
			setDeployed( blocks );
		} catch ( e ) {
			// Non-critical.
		}
	};

	/* ---- Send prompt to Claude via our server-side proxy ---- */
	const handleGenerate = useCallback( async () => {
		if ( ! prompt.trim() ) return;

		setIsLoading( true );
		setResponse( null );
		setParsedBlock( null );
		setNotice( null );

		// Tick an elapsed-seconds counter for the button. The request is a single
		// blocking call (no streaming), so elapsed time is the only honest
		// progress signal we can show while we wait for the full response.
		setElapsed( 0 );
		const startedAt = Date.now();
		timerRef.current = setInterval( () => {
			setElapsed( Math.floor( ( Date.now() - startedAt ) / 1000 ) );
		}, 1000 );

		try {
			const result = await apiFetch( {
				path: '/block-foundry/v1/prompt',
				method: 'POST',
				data: { message: prompt },
			} );

			setResponse( result.response );

			// Try to parse the JSON block data.
			try {
				let cleaned = result.response;
				// Strip markdown fences if present.
				cleaned = cleaned.replace( /^```(?:json)?\s*/i, '' );
				cleaned = cleaned.replace( /\s*```$/i, '' );
				const parsed = JSON.parse( cleaned );

				if ( parsed.slug && parsed.files ) {
					setParsedBlock( parsed );
					setNotice( {
						status: 'success',
						message: `Block "${ parsed.title || parsed.slug }" generated! Review the code below then click Deploy.`,
					} );
				} else {
					setNotice( {
						status: 'warning',
						message: 'Claude responded but the output was not valid block JSON. You can try refining your prompt.',
					} );
				}
			} catch ( parseErr ) {
				setNotice( {
					status: 'warning',
					message: 'Claude responded but the output could not be parsed as JSON. Check the raw response.',
				} );
			}
		} catch ( err ) {
			setNotice( {
				status: 'error',
				message: err.message || 'Something went wrong talking to the AI.',
			} );
		} finally {
			clearInterval( timerRef.current );
			setIsLoading( false );
		}
	}, [ prompt ] );

	/* ---- Deploy the parsed block ---- */
	const handleDeploy = useCallback( async () => {
		if ( ! parsedBlock ) return;

		setIsDeploying( true );
		setNotice( null );

		try {
			const result = await apiFetch( {
				path: '/block-foundry/v1/deploy-block',
				method: 'POST',
				data: { block_data: JSON.stringify( parsedBlock ) },
			} );

			if ( result.ok ) {
				setNotice( {
					status: 'success',
					message: `Block "${ result.title }" deployed! Refreshing the editor…`,
				} );

				// Register the new block in the editor so it appears in the inserter.
				await refreshBlockRegistry( parsedBlock );
				await fetchDeployedBlocks();
			}
		} catch ( err ) {
			setNotice( {
				status: 'error',
				message: err.message || 'Deploy failed.',
			} );
		} finally {
			setIsDeploying( false );
		}
	}, [ parsedBlock ] );

	/* ---- Delete a deployed block ---- */
	const handleDelete = useCallback( async ( slug ) => {
		try {
			await apiFetch( {
				path: `/block-foundry/v1/blocks/${ slug }`,
				method: 'DELETE',
			} );

			setNotice( {
				status: 'info',
				message: `Block "${ slug }" removed. Refresh the page to update the inserter.`,
			} );

			await fetchDeployedBlocks();
		} catch ( err ) {
			setNotice( {
				status: 'error',
				message: err.message || 'Could not delete block.',
			} );
		}
	}, [] );

	/* ---- Make a freshly deployed block usable in the editor ---- */
	const refreshBlockRegistry = async ( block ) => {
		// HOT-LOAD PATH (ENABLE_HOT_RELOAD): register the block in the live
		// editor so it appears in the inserter immediately. The whole thing is
		// wrapped in try/catch — any failure falls through to the reload nudge.
		//
		// Why this is needed: the inserter is driven by the client-side block
		// registry (wp.blocks), which is populated only when a block's index.js
		// runs registerBlockType() in the browser. PHP enqueues that script at
		// PAGE LOAD, so a just-deployed block's code isn't in the running editor.
		// We pull it in manually below.
		if ( ENABLE_HOT_RELOAD && block?.files?.[ 'block.json' ] ) {
			try {
				const meta    = JSON.parse( block.files[ 'block.json' ] );
				const baseUrl = window.bfEditor.pluginUrl + 'generated-blocks/' + block.slug + '/';
				// Cache-buster so re-deploys load fresh code, not a stale copy.
				const ver = '?ver=' + Date.now();

				// Re-deploy guard: re-registering an existing block name throws,
				// so drop any prior client registration from this session first.
				if ( getBlockType( meta.name ) ) {
					unregisterBlockType( meta.name );
				}

				// Hand the block.json metadata (attributes, title, category, …)
				// to the editor exactly the way a normal page load would. Without
				// this, the block's index.js — which registers only { edit, save }
				// — would produce a block with no attributes or title.
				// NOTE: unstable__ API; see the ENABLE_HOT_RELOAD comment.
				unstable__bootstrapServerSideBlockDefinitions( { [ meta.name ]: meta } );

				// Styles are non-blocking; the index.js (registerBlockType) is the
				// one we must await before checking the result.
				if ( block.files[ 'style.css' ] ) {
					injectStyle( baseUrl + 'style.css' + ver );
				}
				if ( block.files[ 'editor.css' ] ) {
					injectStyle( baseUrl + 'editor.css' + ver );
				}
				await injectScript( baseUrl + 'index.js' + ver );

				// Confirm it actually landed in the registry before declaring success.
				if ( getBlockType( meta.name ) ) {
					setNotice( {
						status: 'success',
						message: `Block "${ block.title || block.slug }" is ready — find it in the inserter. No reload needed.`,
					} );
					return;
				}
			} catch ( e ) {
				// Intentional: drop through to the reload fallback below.
			}
		}

		// FALLBACK PATH (hot-load disabled or failed): nudge a manual reload,
		// which always works because PHP re-enqueues every block on page load.
		window.dispatchEvent( new CustomEvent( 'bf-block-deployed' ) );
		setNotice( ( prev ) => ( {
			...( prev || {} ),
			status: 'success',
			message: ( prev?.message || 'Block deployed!' ) + ' Click "Reload Editor" below to see it in the inserter.',
		} ) );
	};

	/* ---- Render ---- */
	return (
		<>
			<PluginSidebarMoreMenuItem target="block-foundry-sidebar">
				Block Foundry
			</PluginSidebarMoreMenuItem>

			<PluginSidebar
				name="block-foundry-sidebar"
				title="Block Foundry"
				icon={ ICON }
			>
				<div className="bf-sidebar">

					{ notice && (
						<Notice
							status={ notice.status }
							isDismissible
							onDismiss={ () => setNotice( null ) }
						>
							{ notice.message }
						</Notice>
					) }

					<TabPanel
						className="bf-tabs"
						activeClass="is-active"
						tabs={ [
							{ name: 'generate', title: 'Generate', className: 'bf-tab' },
							{ name: 'blocks',   title: 'My Blocks', className: 'bf-tab' },
						] }
						onSelect={ setActiveTab }
					>
						{ ( tab ) => (
							<>
								{ tab.name === 'generate' && (
									<div className="bf-generate-tab">
										<Panel>
											<PanelBody title="Describe Your Block" initialOpen>
												<PanelRow>
													<TextareaControl
														ref={ textareaRef }
														label="What block do you need?"
														help="Be specific: include attributes, styling, and behavior."
														value={ prompt }
														onChange={ setPrompt }
														rows={ 6 }
														placeholder="e.g. A testimonial card block with fields for author name, photo, quote text, and a star rating from 1–5. Use a soft shadow and rounded corners."
													/>
												</PanelRow>

												<PanelRow>
													<Button
														variant="primary"
														onClick={ handleGenerate }
														disabled={ isLoading || ! prompt.trim() }
														isBusy={ isLoading }
														className="bf-generate-btn"
													>
														{ isLoading ? (
															<>
																<Spinner /> Generating… { elapsed }s
															</>
														) : (
															'Generate Block'
														) }
													</Button>
												</PanelRow>
											</PanelBody>
										</Panel>

										{ parsedBlock && (
											<Panel>
												<PanelBody title="Preview" initialOpen>
													<div className="bf-preview-meta">
														<strong>{ parsedBlock.title }</strong>
														<p>{ parsedBlock.description }</p>
														<code>{ parsedBlock.slug }</code>
													</div>

													<div className="bf-file-list">
														<strong>Files:</strong>
														<ul>
															{ Object.keys( parsedBlock.files ).map( ( f ) => (
																<li key={ f }><code>{ f }</code></li>
															) ) }
														</ul>
													</div>

													<details className="bf-raw-response">
														<summary>View Raw JSON</summary>
														<pre>{ JSON.stringify( parsedBlock, null, 2 ) }</pre>
													</details>

													<div className="bf-deploy-actions">
														<Button
															variant="primary"
															onClick={ handleDeploy }
															disabled={ isDeploying }
															isBusy={ isDeploying }
														>
															{ isDeploying ? (
																<>
																	<Spinner /> Deploying…
																</>
															) : (
																'Deploy Block'
															) }
														</Button>

														<Button
															variant="secondary"
															onClick={ () => window.location.reload() }
															className="bf-reload-btn"
														>
															Reload Editor
														</Button>
													</div>
												</PanelBody>
											</Panel>
										) }

										{ response && ! parsedBlock && (
											<Panel>
												<PanelBody title="Raw Response" initialOpen>
													<pre className="bf-raw-response-text">
														{ response }
													</pre>
												</PanelBody>
											</Panel>
										) }
									</div>
								) }

								{ tab.name === 'blocks' && (
									<div className="bf-blocks-tab">
										<Panel>
											<PanelBody title="Deployed Blocks" initialOpen>
												{ deployedBlocks.length === 0 ? (
													<p className="bf-empty">
														No blocks generated yet. Use the Generate tab to create one!
													</p>
												) : (
													<ul className="bf-block-list">
														{ deployedBlocks.map( ( b ) => (
															<li key={ b.slug } className="bf-block-item">
																<div className="bf-block-info">
																	<strong>{ b.title }</strong>
																	<code>{ b.slug }</code>
																	<span className="bf-block-date">{ b.created }</span>
																</div>
																<Button
																	variant="tertiary"
																	isDestructive
																	onClick={ () => handleDelete( b.slug ) }
																	className="bf-delete-btn"
																>
																	Remove
																</Button>
															</li>
														) ) }
													</ul>
												) }
											</PanelBody>
										</Panel>
									</div>
								) }
							</>
						) }
					</TabPanel>
				</div>
			</PluginSidebar>
		</>
	);
};

/* ------------------------------------------------------------------ */
/*  Register the plugin                                                */
/* ------------------------------------------------------------------ */

registerPlugin( 'block-foundry', {
	render: BlockFoundryPanel,
	icon: ICON,
} );
