=== Block Foundry ===
Tags: blocks, gutenberg, ai, claude, block generator
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later

Generate custom Gutenberg blocks on the fly using Claude AI — directly from the block editor.

== Description ==

Block Foundry adds a sidebar panel to the WordPress block editor that lets you describe any custom block in plain language. Your prompt is sent server-side to the Anthropic API (your key never leaves the server), and Claude generates a complete, production-ready block with all required files.

One click deploys the block to your site and refreshes the editor so it appears in the inserter immediately.

**Features:**

* AI-powered block generation via Claude
* Server-side API proxy — your Anthropic key is never exposed to the browser
* One-click deploy writes block files and registers them dynamically
* Generated blocks use plain JS (no build step required)
* Manage and delete generated blocks from the sidebar or settings page
* Blocks persist across page loads — they are real registered block types

== Installation ==

1. Upload the `block-foundry` directory to `/wp-content/plugins/`
2. Activate the plugin
3. Go to **Settings → Block Foundry** and enter your Anthropic API key
4. Open the block editor — find "Block Foundry" in the sidebar (top-right plugins area)
5. Describe the block you want and click **Generate Block**
6. Review the output, then click **Deploy Block**
7. Click **Reload Editor** to see your new block in the inserter

== How block generation works ==

When you submit a prompt, the server-side proxy (`includes/class-bf-rest-proxy.php`) sends it to the Anthropic Messages API and needs Claude to reply with a strict, machine-parseable block definition — slug, title, and a map of files — with no prose or markdown around it.

Rather than ask for raw JSON in the prompt and hope for clean output, we force the shape using **tool use as a structured-output mechanism**:

* We declare a single custom tool, `emit_block`, whose `input_schema` *is* the block definition we want back. It is not a "real" tool — there is no function behind it and we never send a tool result. It is a JSON Schema wearing a tool costume.
* We set `tool_choice` to `{"type": "tool", "name": "emit_block"}`, which forces Claude to respond by calling that one tool. The model can only answer with a `tool_use` block whose `input` conforms to the schema — never free text, never a ```json fence.
* The proxy reads the `tool_use` block's `input` (an already-parsed object), re-encodes it to a JSON string, and hands it to the browser. The `/deploy-block` endpoint then writes each file in the `files` map to disk.

Notes for anyone modifying this:

* `emit_block` is an arbitrary name we chose — nothing keys off it server-side at Anthropic. If you rename the tool in the request, also update the matching `'emit_block' === $block['name']` check in the extraction loop.
* The `files` schema uses `additionalProperties` of type string, so it stays a flexible filename => contents map (Claude includes whichever files a given block needs).
* This replaced an earlier approach that prefilled the assistant turn with an opening ```json fence. Assistant-message prefill is rejected by current Claude models (Sonnet 4.6 / Opus 4.6+), which require the conversation to end on a user turn — forced tool use is the supported way to guarantee structured output.

== Building the JS ==

npm install
npm run build

For development with hot reload:

npm run start

== Changelog ==

= 1.0.0 =
* Initial release.
