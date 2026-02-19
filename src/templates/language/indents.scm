; =============================================================================
; Auto-Indentation Queries
; =============================================================================
; This file defines indentation rules for automatic formatting.
; See: https://zed.dev/docs/extensions/languages#auto-indentation
;
; Captures:
;   @end    - Closing bracket/brace that ends an indented block
;   @indent - Entire block that should increase indentation
;
; Example for block-based languages:
;   (block "}" @end) @indent
;   (function "}" @end) @indent
;
; Example for indentation-based languages:
;   (list_item) @indent

