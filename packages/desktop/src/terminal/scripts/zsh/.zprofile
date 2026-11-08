# Appling Desktop shell integration: zsh reads this file instead of the user's .zprofile, which it reads in turn.
__appling_zdotdir=$ZDOTDIR
ZDOTDIR=${APPLING_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zprofile ]] && builtin source $ZDOTDIR/.zprofile
APPLING_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__appling_zdotdir
builtin unset __appling_zdotdir
