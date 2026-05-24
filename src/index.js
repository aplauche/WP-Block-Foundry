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
import { dispatch } from '@wordpress/data';
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

/**
 * Extract the block's editable fields from its block.json (which we already
 * hold client-side as a string in the generated payload). Drives the Preview
 * panel's field list.
 *
 * @param {Object} block Parsed block payload with a files['block.json'] string.
 * @return {Array<{name: string, type: string}>} Field descriptors; empty if block.json can't be parsed.
 */
const parseBlockFields = ( block ) => {
	try {
		const attrs = JSON.parse( block.files[ 'block.json' ] ).attributes || {};
		return Object.keys( attrs ).map( ( name ) => ( {
			name,
			type: attrs[ name ].type || 'mixed',
		} ) );
	} catch ( e ) {
		return [];
	}
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
	// Full conversation with Claude for the block currently in preview, oldest
	// turn first: [ { role:'user', content }, { role:'assistant', content }, … ].
	// We replay it on each refinement so Claude edits its own prior output.
	const [ conversation, setConversation ] = useState( [] );
	// The pending "request changes" text in the preview panel.
	const [ refineText, setRefineText ]     = useState( '' );
	const [ isRefining, setIsRefining ]     = useState( false );
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

	/* ---- Elapsed-seconds counter shared by generate + refine ---- */
	// Both calls are single, blocking (non-streaming) requests, so elapsed time
	// is the only honest progress signal we can show while we wait.
	const startTimer = () => {
		setElapsed( 0 );
		const startedAt = Date.now();
		timerRef.current = setInterval( () => {
			setElapsed( Math.floor( ( Date.now() - startedAt ) / 1000 ) );
		}, 1000 );
	};
	const stopTimer = () => clearInterval( timerRef.current );

	/**
	 * Parse Claude's response string into a block object, or null if it isn't
	 * valid block JSON. Tolerates stray markdown fences.
	 *
	 * @param {string} text Raw response string from the /prompt endpoint.
	 * @return {Object|null} Parsed block, or null when it isn't usable.
	 */
	const parseBlockResponse = ( text ) => {
		try {
			const cleaned = text
				.replace( /^```(?:json)?\s*/i, '' )
				.replace( /\s*```$/i, '' );
			const parsed = JSON.parse( cleaned );
			return parsed.slug && parsed.files ? parsed : null;
		} catch ( e ) {
			return null;
		}
	};

	/**
	 * POST a message (plus any prior turns) to the proxy and return the raw
	 * response string. Shared by the initial generation and every refinement.
	 *
	 * @param {string} message The new user message.
	 * @param {Array}  history Prior conversation turns, oldest-first.
	 * @return {Promise<string>} Claude's response string.
	 */
	const requestBlock = async ( message, history ) => {
		const result = await apiFetch( {
			path: '/block-foundry/v1/prompt',
			method: 'POST',
			data: { message, history },
		} );
		return result.response;
	};

	/* ---- Send the initial prompt to Claude via our server-side proxy ---- */
	const handleGenerate = useCallback( async () => {
		if ( ! prompt.trim() ) return;

		setIsLoading( true );
		setResponse( null );
		setParsedBlock( null );
		setNotice( null );
		setConversation( [] );
		setRefineText( '' );
		startTimer();

		try {
			const responseText = await requestBlock( prompt, [] );
			setResponse( responseText );

			const parsed = parseBlockResponse( responseText );
			if ( parsed ) {
				setParsedBlock( parsed );
				// Seed the conversation so the next message can refine this block.
				setConversation( [
					{ role: 'user', content: prompt },
					{ role: 'assistant', content: responseText },
				] );
				setNotice( {
					status: 'success',
					message: `Block "${ parsed.title || parsed.slug }" generated! Review the fields below — request changes or deploy.`,
				} );
			} else {
				setNotice( {
					status: 'warning',
					message: 'Claude responded but the output was not valid block JSON. You can try refining your prompt.',
				} );
			}
		} catch ( err ) {
			setNotice( {
				status: 'error',
				message: err.message || 'Something went wrong talking to the AI.',
			} );
		} finally {
			stopTimer();
			setIsLoading( false );
		}
	}, [ prompt ] );

	/* ---- Send a follow-up edit request, replacing the previewed block ---- */
	const handleRefine = useCallback( async () => {
		const instruction = refineText.trim();
		if ( ! instruction || ! parsedBlock ) return;

		setIsRefining( true );
		setNotice( null );
		startTimer();

		try {
			const responseText = await requestBlock( instruction, conversation );

			const parsed = parseBlockResponse( responseText );
			if ( parsed ) {
				setParsedBlock( parsed );
				setResponse( responseText );
				// Record both turns so further edits keep the full context.
				setConversation( [
					...conversation,
					{ role: 'user', content: instruction },
					{ role: 'assistant', content: responseText },
				] );
				setRefineText( '' );
				setNotice( {
					status: 'success',
					message: 'Block updated. Review the changes — request more edits or deploy.',
				} );
			} else {
				// Keep the existing previewed block and the user's text so they
				// can rephrase rather than losing their request.
				setNotice( {
					status: 'warning',
					message: 'Claude responded but the updated output was not valid block JSON. Try rephrasing your edit.',
				} );
			}
		} catch ( err ) {
			setNotice( {
				status: 'error',
				message: err.message || 'Something went wrong talking to the AI.',
			} );
		} finally {
			stopTimer();
			setIsRefining( false );
		}
	}, [ refineText, parsedBlock, conversation ] );

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
				// Register the new block in the editor so it appears in the
				// inserter. On success this fires a toast in the main window; on
				// fallback it sets a "reload" notice in the sidebar.
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
					// Surface success as a toast (snackbar) in the main editor
					// window, and clear the sidebar notice so it lives in one place.
					setNotice( null );
					dispatch( 'core/notices' ).createNotice(
						'success',
						`Block "${ block.title || block.slug }" added — find it in the inserter.`,
						{ type: 'snackbar', isDismissible: true }
					);
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

	/* ---- Derive the editable field list shown in the Preview panel ---- */
	const blockFields = parsedBlock ? parseBlockFields( parsedBlock ) : [];

	/* ---- The edit requests sent so far (the user turns after the first) ---- */
	const editRequests = conversation
		.filter( ( turn, i ) => i > 0 && turn.role === 'user' )
		.map( ( turn ) => turn.content );

	const isBusy = isLoading || isDeploying || isRefining;

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
														disabled={ isBusy || ! prompt.trim() }
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

													<div className="bf-field-list">
														<strong>Fields</strong>
														{ blockFields.length === 0 ? (
															<p className="bf-empty">This block has no configurable fields.</p>
														) : (
															<ul>
																{ blockFields.map( ( f ) => (
																	<li key={ f.name }>
																		<code>{ f.name }</code>
																		<span className="bf-field-type">{ f.type }</span>
																	</li>
																) ) }
															</ul>
														) }
													</div>

													{ /* Iterate on the block before committing it to disk:
													     send Claude an edit request and swap in the revised
													     block it returns. */ }
													<div className="bf-refine">
														{ editRequests.length > 0 && (
															<ol className="bf-refine-log">
																{ editRequests.map( ( req, i ) => (
																	<li key={ i }>{ req }</li>
																) ) }
															</ol>
														) }

														<TextareaControl
															label="Request changes"
															help="Describe what to adjust, then send it back to Claude before deploying."
															value={ refineText }
															onChange={ setRefineText }
															rows={ 3 }
															placeholder="e.g. Add a subtitle field and let the star rating go up to 10."
															disabled={ isBusy }
														/>

														<Button
															variant="secondary"
															onClick={ handleRefine }
															disabled={ isBusy || ! refineText.trim() }
															isBusy={ isRefining }
															className="bf-refine-btn"
														>
															{ isRefining ? (
																<>
																	<Spinner /> Updating… { elapsed }s
																</>
															) : (
																'Send to Claude'
															) }
														</Button>
													</div>

													<div className="bf-deploy-actions">
														<Button
															variant="primary"
															onClick={ handleDeploy }
															disabled={ isBusy }
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
