# Appling Desktop shell integration for bash: marks prompts and commands with OSC 633, the way VS Code does.
# bash runs this file with --init-file instead of ~/.bashrc, so it reads the user's startup files itself first.

if [ -n "${APPLING_SHELL_LOGIN-}" ]; then
    builtin unset APPLING_SHELL_LOGIN
    [ -r /etc/profile ] && builtin . /etc/profile
    for __appling_file in ~/.bash_profile ~/.bash_login ~/.profile; do
        if [ -r "$__appling_file" ]; then
            builtin . "$__appling_file"
            break
        fi
    done
    builtin unset __appling_file
else
    [ -r ~/.bashrc ] && builtin . ~/.bashrc
fi
builtin unset APPLING_SHELL_INTEGRATION

if [[ "$-" != *i* ]] || [ -n "${__appling_loaded-}" ]; then
    builtin return 0 2>/dev/null || true
else
__appling_loaded=1

# Sets __appling_escaped to the value with \ as \\ and ; and control characters as \xHH.
__appling_escape() {
    local text="$1" out="" c i
    for (( i = 0; i < ${#text}; i++ )); do
        c="${text:i:1}"
        case "$c" in
            '\') out+='\\' ;;
            ';') out+='\x3b' ;;
            [[:cntrl:]]) builtin printf -v c '\\x%02x' "'$c"; out+="$c" ;;
            *) out+="$c" ;;
        esac
    done
    __appling_escaped="$out"
}

__appling_status=0
__appling_executing=
__appling_in_prompt=1
__appling_history=
__appling_ps1=

__appling_history_number() {
    local entry
    entry="$(HISTTIMEFORMAT= builtin history 1)"
    [[ "$entry" =~ ^\ *([0-9]+) ]] && builtin printf '%s' "${BASH_REMATCH[1]}"
}

# The DEBUG trap fires before every simple command; the first one after a prompt starts the command line.
__appling_preexec() {
    [ -n "$__appling_in_prompt" ] && return
    [ -n "$__appling_executing" ] && return
    [ -n "${COMP_LINE-}" ] && return
    [[ "$BASH_COMMAND" == __appling_prompt_start* ]] && return
    __appling_executing=1
    local entry command
    entry="$(HISTTIMEFORMAT= builtin history 1)"
    if [[ "$entry" =~ ^\ *([0-9]+)\ \ (.*)$ ]] && [ "${BASH_REMATCH[1]}" != "$__appling_history" ]; then
        command="${BASH_REMATCH[2]}"
    else
        # not added to the history (HISTCONTROL): the first simple command is the best there is
        command="$BASH_COMMAND"
    fi
    __appling_escape "$command"
    builtin printf '\e]633;E;%s\a\e]633;C\a' "$__appling_escaped"
}

__appling_prompt_start() {
    __appling_status=$?
    __appling_in_prompt=1
    return $__appling_status
}

__appling_prompt_end() {
    if [ -n "$__appling_executing" ]; then
        builtin printf '\e]633;D;%s\a' "$__appling_status"
    fi
    __appling_executing=
    __appling_escape "$PWD"
    builtin printf '\e]633;P;Cwd=%s\a' "$__appling_escaped"
    __appling_history="$(__appling_history_number)"
    # a prompt command (starship, ...) may set PS1 anew each time; wrap whatever it is now
    if [[ "$PS1" != *'\[\e]633;A\a\]'* ]]; then __appling_ps1="$PS1"; fi
    PS1='\[\e]633;A\a\]'"$__appling_ps1"'\[\e]633;B\a\]'
    __appling_in_prompt=
    return $__appling_status
}

if [ -z "$(builtin trap -p DEBUG)" ]; then
    builtin trap '__appling_preexec' DEBUG
else
    # another DEBUG trap (bash-preexec, ...) is kept: PS0 marks the command start, without its command line
    PS0='\e]633;C\a'"${PS0-}"
    __appling_preexec() { :; }
    __appling_prompt_start() { __appling_status=$?; __appling_executing=1; __appling_in_prompt=1; return $__appling_status; }
fi
PROMPT_COMMAND="__appling_prompt_start${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __appling_prompt_end"
fi
