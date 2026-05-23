<?php
/**
 * Settings page — stores the Anthropic API key securely in wp_options.
 *
 * @package BlockFoundry
 */

defined( 'ABSPATH' ) || exit;

class BF_Settings {

	const OPTION_KEY = 'bf_anthropic_api_key';
	const OPTION_GROUP = 'bf_settings';
	const PAGE_SLUG = 'block-foundry';

	/**
	 * Wire up.
	 */
	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'add_menu' ) );
		add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
	}

	/**
	 * Add settings page under the Settings menu.
	 */
	public static function add_menu() {
		add_options_page(
			__( 'Block Foundry', 'block-foundry' ),
			__( 'Block Foundry', 'block-foundry' ),
			'manage_options',
			self::PAGE_SLUG,
			array( __CLASS__, 'render_page' )
		);
	}

	/**
	 * Register the setting.
	 */
	public static function register_settings() {
		register_setting( self::OPTION_GROUP, self::OPTION_KEY, array(
			'type'              => 'string',
			'sanitize_callback' => array( __CLASS__, 'sanitize_api_key' ),
			'default'           => '',
			'show_in_rest'      => false,
		) );

		add_settings_section(
			'bf_main',
			__( 'API Configuration', 'block-foundry' ),
			function () {
				echo '<p>' . esc_html__( 'Enter your Anthropic API key. It is stored in the database and never sent to the browser.', 'block-foundry' ) . '</p>';
			},
			self::PAGE_SLUG
		);

		add_settings_field(
			self::OPTION_KEY,
			__( 'Anthropic API Key', 'block-foundry' ),
			array( __CLASS__, 'render_field' ),
			self::PAGE_SLUG,
			'bf_main'
		);
	}

	/**
	 * Render the settings page.
	 */
	public static function render_page() {
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Block Foundry Settings', 'block-foundry' ); ?></h1>
			<form method="post" action="options.php">
				<?php
				settings_fields( self::OPTION_GROUP );
				do_settings_sections( self::PAGE_SLUG );
				submit_button();
				?>
			</form>

			<hr>
			<h2><?php esc_html_e( 'Generated Blocks', 'block-foundry' ); ?></h2>
			<?php self::render_block_list(); ?>
		</div>
		<?php
	}

	/**
	 * Render the API key field.
	 */
	public static function render_field() {
		$value  = get_option( self::OPTION_KEY, '' );
		$has_key = ! empty( $value );
		$masked  = $has_key ? str_repeat( '•', 12 ) . substr( $value, -4 ) : '';
		?>
		<input
			type="password"
			id="<?php echo esc_attr( self::OPTION_KEY ); ?>"
			name="<?php echo esc_attr( self::OPTION_KEY ); ?>"
			value=""
			class="regular-text"
			autocomplete="off"
			placeholder="<?php echo $has_key ? esc_attr( $masked ) : 'sk-ant-...'; ?>"
		/>
		<?php if ( $has_key ) : ?>
			<p class="description"><?php echo esc_html( sprintf( __( 'Current key: %s — leave blank to keep the existing key.', 'block-foundry' ), $masked ) ); ?></p>
		<?php endif; ?>
		<?php
	}

	/**
	 * List generated blocks on the settings page.
	 */
	private static function render_block_list() {
		if ( ! is_dir( BF_GENERATED_DIR ) ) {
			echo '<p>' . esc_html__( 'No blocks generated yet.', 'block-foundry' ) . '</p>';
			return;
		}

		$dirs = glob( BF_GENERATED_DIR . '*', GLOB_ONLYDIR );

		if ( empty( $dirs ) ) {
			echo '<p>' . esc_html__( 'No blocks generated yet.', 'block-foundry' ) . '</p>';
			return;
		}

		echo '<table class="widefat fixed striped"><thead><tr>';
		echo '<th>' . esc_html__( 'Block', 'block-foundry' ) . '</th>';
		echo '<th>' . esc_html__( 'Slug', 'block-foundry' ) . '</th>';
		echo '<th>' . esc_html__( 'Created', 'block-foundry' ) . '</th>';
		echo '</tr></thead><tbody>';

		foreach ( $dirs as $dir ) {
			$meta_file = $dir . '/meta.json';
			if ( ! file_exists( $meta_file ) ) {
				continue;
			}
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
			$meta = json_decode( file_get_contents( $meta_file ), true );
			echo '<tr>';
			echo '<td>' . esc_html( $meta['title'] ?? basename( $dir ) ) . '</td>';
			echo '<td><code>' . esc_html( $meta['slug'] ?? '' ) . '</code></td>';
			echo '<td>' . esc_html( $meta['created'] ?? '—' ) . '</td>';
			echo '</tr>';
		}

		echo '</tbody></table>';
	}

	/**
	 * Sanitize the API key on save.
	 * If the field is blank, keep the existing stored key.
	 */
	public static function sanitize_api_key( $value ) {
		$value = sanitize_text_field( $value );

		// Blank submission = keep existing key.
		if ( empty( $value ) ) {
			return get_option( self::OPTION_KEY, '' );
		}

		return self::encrypt( $value );
	}

	/* ------------------------------------------------------------------ */
	/*  Encryption helpers                                                 */
	/* ------------------------------------------------------------------ */

	/**
	 * Encrypt a value using the site's auth salt.
	 * Falls back to storing as-is if OpenSSL is unavailable.
	 */
	private static function encrypt( $plaintext ) {
		if ( ! function_exists( 'openssl_encrypt' ) ) {
			return $plaintext;
		}

		$key    = self::encryption_key();
		$iv     = openssl_random_pseudo_bytes( 16 );
		$cipher = openssl_encrypt( $plaintext, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv );

		if ( false === $cipher ) {
			return $plaintext;
		}

		// Store as base64: iv + ciphertext, prefixed with a marker.
		return 'enc:' . base64_encode( $iv . $cipher );
	}

	/**
	 * Decrypt a stored value.
	 */
	private static function decrypt( $stored ) {
		// Not encrypted (legacy or fallback).
		if ( 0 !== strpos( $stored, 'enc:' ) ) {
			return $stored;
		}

		if ( ! function_exists( 'openssl_decrypt' ) ) {
			return '';
		}

		$key  = self::encryption_key();
		$raw  = base64_decode( substr( $stored, 4 ) );
		$iv   = substr( $raw, 0, 16 );
		$data = substr( $raw, 16 );

		$plaintext = openssl_decrypt( $data, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv );

		return ( false !== $plaintext ) ? $plaintext : '';
	}

	/**
	 * Derive an encryption key from WordPress salts.
	 */
	private static function encryption_key() {
		$salt = defined( 'AUTH_SALT' ) ? AUTH_SALT : 'block-foundry-default-salt';
		return hash( 'sha256', $salt . 'block-foundry-key', true );
	}

	/**
	 * Helper to retrieve the API key (decrypted).
	 */
	public static function get_api_key() {
		$stored = get_option( self::OPTION_KEY, '' );

		if ( empty( $stored ) ) {
			return '';
		}

		return self::decrypt( $stored );
	}
}
