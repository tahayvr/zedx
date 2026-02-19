; =============================================================================
; Syntax Highlighting Queries
; =============================================================================
; This file defines syntax highlighting rules using Tree-sitter queries.
; See: https://zed.dev/docs/extensions/languages#syntax-highlighting
;
; Capture names (prefix with @):
;   @string         - String literals
;   @number         - Numeric values
;   @comment        - Comments
;   @keyword        - Keywords
;   @function       - Functions
;   @type           - Types
;   @variable       - Variables
;   @property       - Properties
;   @operator       - Operators
;   @punctuation    - Punctuation
;   @constant       - Constants
;   @attribute      - Attributes
;   @tag            - Tags
;
; Example:
;   (string) @string
;   (number) @number
;   (comment) @comment
;
; Learn more about Tree-sitter queries:
;   https://tree-sitter.github.io/tree-sitter/using-parsers/queries

(string) @string
(number) @number
(comment) @comment
