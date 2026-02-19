; =============================================================================
; Bracket Matching Queries
; =============================================================================
; This file defines matching brackets for rainbow bracket highlighting.
; See: https://zed.dev/docs/extensions/languages#bracket-matching
;
; Captures:
;   @open  - Opening bracket
;   @close - Closing bracket
;
; To exclude from rainbow brackets, add: (#set! rainbow.exclude)
;
; Example:
;   ("(" @open ")" @close)
;   ("[" @open "]" @close)
;   ("{" @open "}" @close)
;
; Note: Quotes need escaping in .scm files:
;   ("\"" @open "\"" @close)

("(" @open ")" @close)
("[" @open "]" @close)
("{" @open "}" @close)
