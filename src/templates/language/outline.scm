; =============================================================================
; Code Outline Queries
; =============================================================================
; This file defines the structure shown in the code outline panel.
; See: https://zed.dev/docs/extensions/languages#code-outlinestructure
;
; Captures:
;   @name   - Display name for the outline item
;   @item   - The entire element to show in outline
;   @context     - Provides context for the item
;   @context.extra - Additional contextual info
;   @annotation   - Annotations (doc comments, decorators)
;
; Example:
;   (function_definition name: (identifier) @name) @item
;   (class_declaration name: (type_identifier) @name) @item

