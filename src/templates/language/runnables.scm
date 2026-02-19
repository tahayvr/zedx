; =============================================================================
; Runnable Code Detection Queries
; =============================================================================
; This file defines rules for detecting runnable code blocks.
; See: https://zed.dev/docs/extensions/languages#runnable-code-detection
;
; Adds run buttons to the editor gutter for executable code/scripts.
;
; Captures:
;   @run     - Where to place the run button
;   @script - Also captures the script name
;
; Other captures (except underscore-prefixed) are exposed as:
;   ZED_CUSTOM_<CAPTURE_NAME> environment variables
;
; Tags (using #set! tag):
;   (#set! tag <tag-name>) - Additional metadata for the runnable
;
; Example for package.json scripts:
;   (pair
;     key: (string (string_content) @_name (#eq? @_name "scripts"))
;     value: (object
;       (pair
;         key: (string (string_content) @run @script))))

