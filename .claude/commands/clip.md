Copy the following text to the system clipboard: $ARGUMENTS

Run this exact command, substituting the text verbatim in place of PAYLOAD (use a quoted
heredoc so backticks, quotes, and `$` in the payload are never shell-expanded):

```
command -v xclip >/dev/null 2>&1 || { echo "xclip not found — run: sudo apt install xclip"; exit 1; }
xclip -selection clipboard <<'EOF'
PAYLOAD
EOF
```

If xclip is missing, report the install hint and stop — do not attempt any other clipboard mechanism.

On success, report only: "Copied N characters" (N = length of the copied text). No other output.
