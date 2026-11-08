# Appling Desktop shell integration: zsh reads this file instead of the user's .zshrc. It reads the user's own
# file, then adds the hooks that mark prompts and commands (appling.zsh).
__appling_zdotdir=$ZDOTDIR
ZDOTDIR=${APPLING_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshrc ]] && builtin source $ZDOTDIR/.zshrc
APPLING_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__appling_zdotdir
builtin unset __appling_zdotdir
[[ -r $ZDOTDIR/appling.zsh ]] && builtin source $ZDOTDIR/appling.zsh
# a login shell still reads .zlogin from here; any other shell is done with its startup files
if [[ ! -o login ]]; then
    ZDOTDIR=$APPLING_USER_ZDOTDIR
    builtin unset APPLING_USER_ZDOTDIR
fi
