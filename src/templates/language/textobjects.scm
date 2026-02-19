; =============================================================================
; Text Object Queries
; =============================================================================
; This file defines text objects for Vim mode navigation.
; See: https://zed.dev/docs/extensions/languages#text-objects
;
; Vim motions using these:
;   [m / ]m      - Previous/next function (or @function.around)
;   [M / ]M      - Previous/next class (or @class.around)
;   af / if      - Around/inside function
;   ac / ic      - Around/inside class
;   gc           - Around comment
;
; Captures:
;   @function.around   - Entire function definition
;   @function.inside  - Function body (inside braces)
;   @class.around      - Entire class definition
;   @class.inside      - Class contents
;   @comment.around    - Entire comment block
;   @comment.inside    - Comment contents
;
; Example:
;   (function_definition) @function.around
;   (function_definition body: (_) @function.inside)
;   (class_declaration) @class.around

