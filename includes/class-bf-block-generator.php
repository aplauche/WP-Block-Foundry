<?php
/**
 * Block Generator — takes Claude's JSON response, writes block files to disk,
 * and triggers dynamic registration so the block appears instantly.
 *
 * @package BlockFoundry
 */

defined( 'ABSPATH' ) || exit;

class BF_Block_Generator {

	/** REST route namespace. */
	const ROUTE_NS = 'block-foundry/v1';

	/**
	 * Wire up.
	 */
	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	/**
	 * Register the /deploy-block route.
	 */
	public static function register_routes() {

		// POST /wp-json/block-foundry/v1/deploy-block
		register_rest_route( self::ROUTE_NS, '/deploy-block', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'handle_deploy' ),
			'permission_callback' => function () {
				return current_user_can( 'manage_options' );
			},
			'args' => array(
				'block_data' => array(
					'required' => true,
					'type'     => 'string', // JSON string from Claude.
				),
			),
		) );

		// GET /wp-json/block-foundry/v1/blocks — list deployed blocks.
		register_rest_route( self::ROUTE_NS, '/blocks', array(
			'methods'             => 'GET',
			'callback'            => array( __CLASS__, 'handle_list' ),
			'permission_callback' => function () {
				return current_user_can( 'edit_posts' );
			},
		) );

		// DELETE /wp-json/block-foundry/v1/blocks/(?P<slug>[a-z0-9-]+)
		register_rest_route( self::ROUTE_NS, '/blocks/(?P<slug>[a-z0-9-]+)', array(
			'methods'             => 'DELETE',
			'callback'            => array( __CLASS__, 'handle_delete' ),
			'permission_callback' => function () {
				return current_user_can( 'manage_options' );
			},
		) );
	}

	/* ------------------------------------------------------------------ */
	/*  Deploy a block                                                     */
	/* ------------------------------------------------------------------ */

	public static function handle_deploy( WP_REST_Request $request ) {

		$raw = $request->get_param( 'block_data' );

		// Claude sometimes wraps in markdown fences — strip them.
		$raw = preg_replace( '/^```(?:json)?\s*/i', '', $raw );
		$raw = preg_replace( '/\s*```$/i', '', $raw );

		$data = json_decode( $raw, true );

		if ( json_last_error() !== JSON_ERROR_NONE || empty( $data['slug'] ) || empty( $data['files'] ) ) {
			return new WP_Error(
				'bf_invalid_block',
				__( 'Could not parse block JSON. Make sure Claude returned valid block data.', 'block-foundry' ),
				array( 'status' => 400 )
			);
		}

		$slug = sanitize_file_name( $data['slug'] );
		$dir  = BF_GENERATED_DIR . $slug . '/';

		// Create directory.
		if ( ! is_dir( $dir ) ) {
			if ( ! wp_mkdir_p( $dir ) ) {
				return new WP_Error(
					'bf_fs_error',
					__( 'Could not create block directory.', 'block-foundry' ),
					array( 'status' => 500 )
				);
			}
		}

		// Write each file.
		foreach ( $data['files'] as $filename => $contents ) {
			$filename = sanitize_file_name( $filename );
			$filepath = $dir . $filename;

			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
			$written = file_put_contents( $filepath, $contents );

			if ( false === $written ) {
				return new WP_Error(
					'bf_write_error',
					sprintf( __( 'Failed to write file: %s', 'block-foundry' ), $filename ),
					array( 'status' => 500 )
				);
			}
		}

		// Save meta.
		$meta = array(
			'slug'        => $slug,
			'title'       => isset( $data['title'] ) ? sanitize_text_field( $data['title'] ) : $slug,
			'description' => isset( $data['description'] ) ? sanitize_text_field( $data['description'] ) : '',
			'category'    => isset( $data['category'] ) ? sanitize_text_field( $data['category'] ) : 'widgets',
			'created'     => current_time( 'mysql' ),
		);
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		file_put_contents( $dir . 'meta.json', wp_json_encode( $meta, JSON_PRETTY_PRINT ) );

		return rest_ensure_response( array(
			'ok'    => true,
			'slug'  => $slug,
			'title' => $meta['title'],
		) );
	}

	/* ------------------------------------------------------------------ */
	/*  List deployed blocks                                               */
	/* ------------------------------------------------------------------ */

	public static function handle_list( WP_REST_Request $request ) {

		$blocks = array();

		if ( ! is_dir( BF_GENERATED_DIR ) ) {
			return rest_ensure_response( $blocks );
		}

		$dirs = glob( BF_GENERATED_DIR . '*', GLOB_ONLYDIR );

		foreach ( $dirs as $dir ) {
			$meta_file = $dir . '/meta.json';
			if ( file_exists( $meta_file ) ) {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
				$meta     = json_decode( file_get_contents( $meta_file ), true );
				$blocks[] = $meta;
			}
		}

		return rest_ensure_response( $blocks );
	}

	/* ------------------------------------------------------------------ */
	/*  Delete a deployed block                                            */
	/* ------------------------------------------------------------------ */

	public static function handle_delete( WP_REST_Request $request ) {

		$slug = sanitize_file_name( $request->get_param( 'slug' ) );
		$dir  = BF_GENERATED_DIR . $slug;

		if ( ! is_dir( $dir ) ) {
			return new WP_Error(
				'bf_not_found',
				__( 'Block not found.', 'block-foundry' ),
				array( 'status' => 404 )
			);
		}

		// Remove all files in the directory.
		$files = glob( $dir . '/*' );
		foreach ( $files as $file ) {
			if ( is_file( $file ) ) {
				unlink( $file ); // phpcs:ignore
			}
		}
		rmdir( $dir ); // phpcs:ignore

		return rest_ensure_response( array( 'ok' => true, 'deleted' => $slug ) );
	}
}
