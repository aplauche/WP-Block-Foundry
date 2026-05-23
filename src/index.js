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
	Icon,
	TabPanel,
} from '@wordpress/components';
import { dispatch, select } from '@wordpress/data';
import apiFetch from '@wordpress/api-fetch';

import './editor.scss';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ICON = (
	<Icon
		icon={() => (
			<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
				<path
					fill="currentColor"
					d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
				/>
			</svg>
		)}
	/>
);

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
	const textareaRef                       = useRef();

	/* ---- Fetch deployed blocks on mount ---- */
	useEffect( () => {
		fetchDeployedBlocks();
	}, [] );

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

				// Refresh the block types store so the new block appears in the inserter.
				await refreshBlockRegistry();
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

	/* ---- Refresh the block registry in the editor ---- */
	const refreshBlockRegistry = async () => {
		// Force the editor to re-fetch registered block types.
		// The cleanest way is to reload the page, but we can be smarter:
		// Dispatch a store invalidation so the inserter picks up new blocks.
		try {
			// Invalidate the block-types cache in the core/blocks store.
			const { invalidateResolutionForStoreSelector } = dispatch( 'core/data' ) || {};
			if ( invalidateResolutionForStoreSelector ) {
				invalidateResolutionForStoreSelector( 'core', 'getBlockTypes' );
			}
		} catch ( e ) {
			// Fallback: no-op — the user can refresh manually.
		}

		// Also dispatch a page-level event that we can hook if needed.
		window.dispatchEvent( new CustomEvent( 'bf-block-deployed' ) );

		// Show a "reload" nudge as a reliable fallback.
		setNotice( ( prev ) => ( {
			...( prev || {} ),
			status: 'success',
			message: ( prev?.message || 'Block deployed!' ) + ' Click the button below to reload the editor and see it in the inserter.',
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
																<Spinner /> Generating…
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
