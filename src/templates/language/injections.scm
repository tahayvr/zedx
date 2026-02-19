; =============================================================================
; Code Injection Queries
; =============================================================================
; This file defines rules for embedding one language within another.
; See: https://zed.dev/docs/extensions/languages#code-injections
;
; Common use cases:
;   - SQL queries in Python strings
;   - Code blocks in Markdown
;   - CSS in HTML style tags
;   - JavaScript in JSX/TSX
;
; Captures:
;   @injection.language - The language identifier (e.g., "python", "javascript")
;   @injection.content - The content to treat as a different language
;
; Example for Markdown code blocks:
;   (fenced_code_block
;     (info_string (language) @injection.language)
;     (code_fence_content) @injection.content)
;
; Example for inline markdown:
;   ((inline) @content (#set! injection.language "markdown-inline"))

