<?php
/**
 * Block Registry — dynamically registers all generated blocks so they
 * appear in the editor inserter without any manual rebuild.
 *
 * Generated blocks use plain JS (no JSX) so they can run without a
 * compile step. This class enqueues each block's scripts/styles and
 * registers the block type from its block.json.
 *
 * @package BlockFoundry
 */

defined( 'ABSPATH' ) || exit;

class BF_Block_Registry {

	/**
	 * Wire up.
	 */
	public static function init() {
		add_action( 'init', array( __CLASS__, 'register_generated_blocks' ) );
	}

	/**
	 * Scan generated-blocks/ and register each one.
	 */
	public static function register_generated_blocks() {

		if ( ! is_dir( BF_GENERATED_DIR ) ) {
			return;
		}

		$dirs = glob( BF_GENERATED_DIR . '*', GLOB_ONLYDIR );

		foreach ( $dirs as $dir ) {
			$block_json = $dir . '/block.json';

			if ( ! file_exists( $block_json ) ) {
				continue;
			}

			// Read block.json to patch asset URLs.
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
			$raw  = file_get_contents( $block_json );
			$meta = json_decode( $raw, true );

			if ( empty( $meta['name'] ) ) {
				continue;
			}

			$slug    = basename( $dir );
			$baseurl = BF_PLUGIN_URL . 'generated-blocks/' . $slug . '/';

			// Enqueue the block's editor script. index.js is self-contained: it
			// defines the edit component inline and registers the block.
			$handle = 'bf-block-' . $slug;

			if ( file_exists( $dir . '/index.js' ) ) {
				wp_register_script(
					$handle,
					$baseurl . 'index.js',
					array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-i18n' ),
					filemtime( $dir . '/index.js' ),
					true
				);
			}

			if ( file_exists( $dir . '/style.css' ) ) {
				wp_register_style(
					$handle . '-style',
					$baseurl . 'style.css',
					array(),
					filemtime( $dir . '/style.css' )
				);
			}

			if ( file_exists( $dir . '/editor.css' ) ) {
				wp_register_style(
					$handle . '-editor',
					$baseurl . 'editor.css',
					array(),
					filemtime( $dir . '/editor.css' )
				);
			}

			// Build register args.
			$args = array();

			if ( file_exists( $dir . '/index.js' ) ) {
				$args['editor_script'] = $handle;
			}
			if ( file_exists( $dir . '/style.css' ) ) {
				$args['style'] = $handle . '-style';
			}
			if ( file_exists( $dir . '/editor.css' ) ) {
				$args['editor_style'] = $handle . '-editor';
			}

			// All generated blocks are dynamic — render.php is the frontend output.
			// block.json declares "render": "file:./render.php" which WP handles
			// natively, but we also set a render_callback as a reliable fallback
			// for older WP versions that don't support the "render" key.
			if ( file_exists( $dir . '/render.php' ) ) {
				$render_path             = $dir . '/render.php';
				$args['render_callback'] = function ( $attributes, $content ) use ( $render_path ) {
					ob_start();
					// $attributes and $content are available inside the template.
					include $render_path;
					return ob_get_clean();
				};
			}

			// Register via block.json path for full metadata support.
			register_block_type( $dir, $args );
		}
	}
}
