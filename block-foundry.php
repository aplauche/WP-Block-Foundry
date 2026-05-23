<?php

/**
 * Plugin Name: Block Foundry
 * Description: Generate custom Gutenberg blocks on the fly using Claude AI. Prompts are sent server-side to keep your API key safe.
 * Version:     1.0.0
 * Author:      Anton Plauche
 * License:     GPL-2.0-or-later
 * Text Domain: block-foundry
 *
 * @package BlockFoundry
 */

defined('ABSPATH') || exit;

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

define('BF_VERSION', '1.0.0');
define('BF_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('BF_PLUGIN_URL', plugin_dir_url(__FILE__));
define('BF_GENERATED_DIR', BF_PLUGIN_DIR . 'generated-blocks/');
define('BF_NAMESPACE', 'block-foundry');

/* ------------------------------------------------------------------ */
/*  Autoload includes                                                  */
/* ------------------------------------------------------------------ */

require_once BF_PLUGIN_DIR . 'includes/class-bf-settings.php';
require_once BF_PLUGIN_DIR . 'includes/class-bf-rest-proxy.php';
require_once BF_PLUGIN_DIR . 'includes/class-bf-block-generator.php';
require_once BF_PLUGIN_DIR . 'includes/class-bf-block-registry.php';

/* ------------------------------------------------------------------ */
/*  Boot                                                               */
/* ------------------------------------------------------------------ */

add_action('plugins_loaded', 'bf_boot');

function bf_boot()
{
	BF_Settings::init();
	BF_REST_Proxy::init();
	BF_Block_Generator::init();
	BF_Block_Registry::init();
}

/* ------------------------------------------------------------------ */
/*  Enqueue editor assets                                              */
/* ------------------------------------------------------------------ */

add_action('enqueue_block_editor_assets', 'bf_enqueue_editor_assets');

function bf_enqueue_editor_assets()
{
	$asset_file = BF_PLUGIN_DIR . 'build/index.asset.php';

	if (! file_exists($asset_file)) {
		return;
	}

	$asset = include $asset_file;

	wp_enqueue_script(
		'block-foundry-editor',
		BF_PLUGIN_URL . 'build/index.js',
		$asset['dependencies'],
		$asset['version'],
		true
	);

	wp_enqueue_style(
		'block-foundry-editor',
		BF_PLUGIN_URL . 'build/index.css',
		array(),
		$asset['version']
	);

	wp_localize_script('block-foundry-editor', 'bfEditor', array(
		'restBase'  => esc_url_raw(rest_url(BF_NAMESPACE . '/v1')),
		'namespace' => BF_NAMESPACE,
	));
}

/* ------------------------------------------------------------------ */
/*  Activation / Deactivation                                          */
/* ------------------------------------------------------------------ */

register_activation_hook(__FILE__, 'bf_activate');

function bf_activate()
{
	// Ensure the generated-blocks directory exists and is writable.
	if (! is_dir(BF_GENERATED_DIR)) {
		wp_mkdir_p(BF_GENERATED_DIR);
	}
}

register_deactivation_hook(__FILE__, 'bf_deactivate');

function bf_deactivate()
{
	// Nothing destructive — generated blocks stay on disk.
}
