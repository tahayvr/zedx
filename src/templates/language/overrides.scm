; =============================================================================
; Syntax Override Queries
; =============================================================================
; This file defines scoped overrides for editor settings.
; See: https://zed.dev/docs/extensions/languages#syntax-overrides
;
; Available overrides:
;   word_characters           - Characters considered part of a word
;   completion_query_characters - Characters that trigger autocomplete
;
; Use .inclusive suffix to make range inclusive (default is exclusive):
;   (comment) @comment.inclusive
;
; Example - JavaScript strings with hyphen completion:
;   (string) @string
;   ; Then set in config.toml:
;   ; [overrides.string]
;   ; completion_query_characters = ["-"]

(string) @string
