<?php
/**
 * REST API proxy – ferries messages to the Anthropic API server-side
 * so the API key is never exposed to the browser.
 *
 * @package BlockFoundry
 */

defined( 'ABSPATH' ) || exit;

class BF_REST_Proxy {

	/** Route namespace. */
	const ROUTE_NS = 'block-foundry/v1';

	/** Anthropic API endpoint. */
	const API_URL = 'https://api.anthropic.com/v1/messages';

	/** Default model. */
	const DEFAULT_MODEL = 'claude-sonnet-4-6';

	/**
	 * Wire up the REST routes.
	 */
	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	/**
	 * Register the /prompt route.
	 */
	public static function register_routes() {

		// POST /wp-json/block-foundry/v1/prompt
		register_rest_route( self::ROUTE_NS, '/prompt', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'handle_prompt' ),
			'permission_callback' => array( __CLASS__, 'check_permissions' ),
			'args'                => array(
				'message' => array(
					'required'          => true,
					'type'              => 'string',
					'sanitize_callback' => 'sanitize_text_field',
				),
				'context' => array(
					'required' => false,
					'type'     => 'string',
					'default'  => '',
				),
				// Optional reference image sent straight to the model as vision
				// input. We do NOT store it in the media library — it lives only
				// in this request. Shape: { media_type: string, data: base64 }.
				'image'   => array(
					'required' => false,
					'type'     => 'object',
					'default'  => null,
				),
			),
		) );
	}

	/**
	 * Only editors+ can use the AI panel.
	 */
	public static function check_permissions( WP_REST_Request $request ) {
		return current_user_can( 'edit_posts' );
	}

	/**
	 * Handle the prompt request — call Anthropic, return the response.
	 *
	 * Includes basic per-user rate limiting to prevent runaway API costs.
	 */
	public static function handle_prompt( WP_REST_Request $request ) {

		// ---- Rate limit: max 10 requests per user per minute ---- //
		$user_id    = get_current_user_id();
		$transient  = 'bf_rate_' . $user_id;
		$count      = (int) get_transient( $transient );

		if ( $count >= 10 ) {
			return new WP_Error(
				'bf_rate_limited',
				__( 'Too many requests. Please wait a minute before trying again.', 'block-foundry' ),
				array( 'status' => 429 )
			);
		}

		set_transient( $transient, $count + 1, MINUTE_IN_SECONDS );

		$api_key = BF_Settings::get_api_key();

		if ( empty( $api_key ) ) {
			return new WP_Error(
				'bf_no_api_key',
				__( 'Anthropic API key is not configured. Go to Settings → Block Foundry.', 'block-foundry' ),
				array( 'status' => 400 )
			);
		}

		$user_message = $request->get_param( 'message' );
		$extra_ctx    = $request->get_param( 'context' );
		$image        = $request->get_param( 'image' );

		$system_prompt = self::build_system_prompt( $extra_ctx );

		// Build the user turn content. Text is always present (required); when a
		// valid reference image was sent, prepend it as a vision block so the
		// model can see what the user wants. The image is used in-request only —
		// never written to disk or the media library.
		$user_content  = array();
		$allowed_types = array( 'image/jpeg', 'image/png', 'image/gif', 'image/webp' );

		if ( is_array( $image )
			&& ! empty( $image['data'] )
			&& ! empty( $image['media_type'] )
			&& in_array( $image['media_type'], $allowed_types, true ) ) {
			$user_content[] = array(
				'type'   => 'image',
				'source' => array(
					'type'       => 'base64',
					'media_type' => $image['media_type'],
					// Strip anything outside the base64 alphabet as a safety net
					// (the client sends the bare data, no "data:" URL prefix).
					'data'       => preg_replace( '/[^A-Za-z0-9+\/=]/', '', $image['data'] ),
				),
			);
		}

		$user_content[] = array(
			'type' => 'text',
			'text' => $user_message,
		);

		// Define the block schema as a tool and force Claude to call it. This is
		// the modern replacement for assistant-prefill JSON forcing — prefill is
		// rejected on Sonnet 4.6 / Opus 4.6+ ("conversation must end with a user
		// message"). With tool_choice pinned to this one tool, the model can ONLY
		// respond by emitting a single tool_use block whose `input` is a structured
		// object — never prose, never a markdown fence. The schema is intentionally
		// non-strict so `files` stays a flexible filename => contents map.
		$tool = array(
			'name'         => 'emit_block',
			'description'  => 'Return the generated WordPress block as structured data.',
			'input_schema' => array(
				'type'       => 'object',
				'properties' => array(
					'slug'        => array(
						'type'        => 'string',
						'description' => 'Block slug, must start with "bf-" (kebab-case).',
					),
					'title'       => array(
						'type'        => 'string',
						'description' => 'Human-readable block title.',
					),
					'description' => array(
						'type'        => 'string',
						'description' => 'One-line description of the block.',
					),
					'category'    => array(
						'type'        => 'string',
						'description' => 'Block category, e.g. "widgets".',
					),
					'files'       => array(
						'type'                 => 'object',
						'description'          => 'Map of filename => full file contents. Must include render.php and index.js; typically also block.json, style.css, editor.css.',
						'additionalProperties' => array( 'type' => 'string' ),
					),
				),
				'required'   => array( 'slug', 'title', 'files' ),
			),
		);

		$body = array(
			'model'       => self::DEFAULT_MODEL,
			'max_tokens'  => 16000,
			'system'      => $system_prompt,
			'tools'       => array( $tool ),
			'tool_choice' => array(
				'type' => 'tool',
				'name' => 'emit_block',
			),
			'messages'    => array(
				array(
					'role'    => 'user',
					'content' => $user_content,
				),
			),
		);

		$response = wp_remote_post( self::API_URL, array(
			'timeout' => 120,
			'headers' => array(
				'Content-Type'      => 'application/json',
				'x-api-key'        => $api_key,
				'anthropic-version' => '2023-06-01',
			),
			'body' => wp_json_encode( $body ),
		) );

		if ( is_wp_error( $response ) ) {
			return new WP_Error(
				'bf_api_error',
				$response->get_error_message(),
				array( 'status' => 502 )
			);
		}

		$code = wp_remote_retrieve_response_code( $response );
		$raw  = wp_remote_retrieve_body( $response );
		$data = json_decode( $raw, true );

		if ( $code < 200 || $code >= 300 ) {
			$err_msg = isset( $data['error']['message'] ) ? $data['error']['message'] : 'Unknown Anthropic API error.';
			return new WP_Error(
				'bf_api_upstream',
				$err_msg,
				array( 'status' => $code )
			);
		}

		// Pull the structured block data out of the forced tool_use block. Claude
		// returns `input` as an already-parsed object; we re-encode it to a JSON
		// string because the browser and the /deploy-block endpoint both expect a
		// JSON string in `response`.
		$text = '';
		if ( ! empty( $data['content'] ) ) {
			foreach ( $data['content'] as $block ) {
				if ( isset( $block['type'], $block['name'] )
					&& 'tool_use' === $block['type']
					&& 'emit_block' === $block['name'] ) {
					$text = wp_json_encode( $block['input'] );
					break;
				}
			}
		}

		if ( '' === $text || false === $text ) {
			return new WP_Error(
				'bf_no_block_data',
				__( 'Claude did not return structured block data. Please try again.', 'block-foundry' ),
				array( 'status' => 502 )
			);
		}

		return rest_ensure_response( array(
			'ok'       => true,
			'response' => $text,
			'usage'    => isset( $data['usage'] ) ? $data['usage'] : null,
		) );
	}

	/**
	 * Build the system prompt that tells Claude how to format block output.
	 */
	private static function build_system_prompt( $extra_ctx = '' ) {
		$prompt = <<<'SYSTEM'
You are an expert WordPress Gutenberg block developer. The user will describe a custom block they need. They may also attach a reference image showing the block's desired appearance — when one is present, treat it as the visual source of truth and match its layout, colours, spacing, and typography as closely as the generated CSS allows.

Your job is to generate the files required for a **dynamic WordPress block** using the modern `block.json` registration method. ALL blocks MUST be dynamic — the frontend is ALWAYS rendered by a `render.php` PHP template. The `save` function in JS MUST return `null` so WordPress stores only block attributes (no static HTML markup).

RESPONSE FORMAT — respond by calling the `emit_block` tool. Pass the block data as the tool input. The `files` argument is a map of filename => full file contents. The overall shape is:

```json
{
  "slug": "bf-<kebab-case-name>",
  "title": "Human Readable Title",
  "description": "One-line description.",
  "category": "widgets",
  "files": {
    "block.json": "<full contents>",
    "index.js": "<full contents — defines the edit component AND registers the block>",
    "render.php": "<full contents — server-side PHP template>",
    "style.css": "<full contents — frontend styles>",
    "editor.css": "<full contents — editor-only styles>"
  }
}
```

RULES:
1. `slug` must start with `bf-`.
2. In `block.json`, set `"name": "block-foundry/<slug>"` and include `"render": "file:./render.php"`. Do NOT include `editorScript`, `style`, or `editorStyle` keys — the PHP registration layer handles asset enqueuing automatically.
3. EVERY block MUST include a `render.php` file. This is the ONLY way frontend output is produced. Never create static blocks.
4. The `save` function MUST always return `null`. No exceptions. All frontend markup comes from `render.php`.
5. `render.php` receives `$attributes` (block attributes array) and `$content` (inner block content string). Use these to render the HTML. Wrap output in a container with `<?php echo get_block_wrapper_attributes(); ?>` for proper block styling support.
6. `index.js` is the ONLY JavaScript file. Define the editor `edit` component inline in `index.js`, then register the block in the SAME file by calling `wp.blocks.registerBlockType( 'block-foundry/<slug>', { edit: EditComponent, save: function() { return null; } } )`. Do NOT create a separate `edit.js`, and do NOT pass the component through a `window` global.
7. Use `wp.blockEditor`, `wp.components`, and `wp.element` — these are available as globals. Access them directly (e.g. `const el = wp.element.createElement;`).
8. Do NOT use JSX. Use `wp.element.createElement` (aliased as `el`) so files work without a build step.
9. Do NOT use ES module import/export syntax. All files are loaded as plain scripts with access to `wp` globals.
10. Keep code clean, well-commented, and production-quality.
11. Always respond via the `emit_block` tool call — never output the JSON as plain text or wrapped in markdown fences.
12. The editor `edit` component should be a rich, interactive preview that closely mirrors what `render.php` will produce on the frontend.
SYSTEM;

		if ( ! empty( $extra_ctx ) ) {
			$prompt .= "\n\nAdditional context from the user's editor:\n" . $extra_ctx;
		}

		return $prompt;
	}
}
