# Appling Desktop shell integration for zsh: marks prompts and commands with OSC 633, the way VS Code does.
[[ -o interactive ]] || return 0
[[ -n $__appling_loaded ]] && return 0
__appling_loaded=1
builtin unset APPLING_SHELL_INTEGRATION

# Sets __appling_escaped to the value with \ as \\ and ; and control characters as \xHH.
__appling_escape() {
    local text=$1 out= c i
    for (( i = 1; i <= ${#text}; i++ )); do
        c=${text[i]}
        case $c in
            ('\') out+='\\' ;;
            (';') out+='\x3b' ;;
            ([[:cntrl:]]) out+=$(builtin printf '\\x%02x' "'$c") ;;
            (*) out+=$c ;;
        esac
    done
    __appling_escaped=$out
}

__appling_executing=
__appling_ps1=

# First of the precmd hooks: the exit status is still the command's.
__appling_precmd_first() {
    local code=$?
    if [[ -n $__appling_executing ]]; then
        builtin printf '\e]633;D;%s\a' $code
    fi
    __appling_executing=
    return $code
}

# Last of the precmd hooks: themes set PS1 in theirs, so this wraps whatever it is now.
__appling_precmd_last() {
    local code=$?
    __appling_escape "$PWD"
    builtin printf '\e]633;P;Cwd=%s\a' "$__appling_escaped"
    if [[ $PS1 != *$'\e]633;A'* ]]; then __appling_ps1=$PS1; fi
    PS1=$'%{\e]633;A\a%}'$__appling_ps1$'%{\e]633;B\a%}'
    return $code
}

__appling_preexec() {
    __appling_escape "$1"
    builtin printf '\e]633;E;%s\a\e]633;C\a' "$__appling_escaped"
    __appling_executing=1
}

precmd_functions=(__appling_precmd_first ${precmd_functions[@]} __appling_precmd_last)
preexec_functions+=(__appling_preexec)
