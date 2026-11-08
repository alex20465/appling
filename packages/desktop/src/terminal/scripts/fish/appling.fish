# Appling Desktop shell integration for fish: marks prompts and commands with OSC 633, the way VS Code does.
# fish runs this file with --init-command, after the user's config.fish.
status is-interactive; or exit
set -q __appling_loaded; and exit
set -g __appling_loaded 1
set -e APPLING_SHELL_INTEGRATION

# The value with \ as \\, ; as \x3b and line breaks and tabs as \xHH.
function __appling_escape
    string replace -a -- '\\' '\\\\' $argv[1] | string replace -a -- ';' '\\x3b' | string replace -a -- \t '\\x09' | string replace -a -- \r '\\x0d' | string join '\x0a'
end

function __appling_status
    return $argv[1]
end

function __appling_preexec --on-event fish_preexec
    printf '\e]633;E;%s\a\e]633;C\a' (__appling_escape "$argv")
    set -g __appling_executing 1
end

function __appling_postexec --on-event fish_postexec
    set -l code $status
    if set -q __appling_executing
        printf '\e]633;D;%s\a' $code
        set -e __appling_executing
    end
end

function __appling_cwd --on-event fish_prompt
    printf '\e]633;P;Cwd=%s\a' (__appling_escape "$PWD")
end

# Wraps the prompt in the prompt marks; the user's prompt still sees the last command's status.
if functions -q fish_prompt
    functions -c fish_prompt __appling_user_prompt
else
    function __appling_user_prompt
        printf '%s> ' (prompt_pwd)
    end
end

function fish_prompt
    set -l code $status
    printf '\e]633;A\a'
    __appling_status $code
    __appling_user_prompt
    printf '\e]633;B\a'
end
