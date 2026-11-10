# Tab completion for the Makefile of the Appling repo, with targets that contain colons (make packages/vscode/host:link),
# which bash-completion's make completion cuts at the colon. Outside the repo it hands over to that completion.
# Source it from ~/.bashrc: source ~/Dev/appling/scripts/make-completion.bash

_comp_load make 2>/dev/null || _completion_loader make 2>/dev/null
_appling_make_fallback=$(complete -p make 2>/dev/null | sed -n 's/.* -F \([^ ]*\) .*/\1/p')

_appling_make() {
    local cur
    _get_comp_words_by_ref -n : cur
    if [[ $cur == -* || $cur == *=* ]] || ! grep -qs '"name": "appling-workspace"' package.json; then
        [[ -n $_appling_make_fallback ]] && "$_appling_make_fallback" "$@"
        return
    fi
    mapfile -t COMPREPLY < <(compgen -W "$(make -s targets 2>/dev/null)" -- "$cur")
    __ltrim_colon_completions "$cur"
}
complete -F _appling_make make
