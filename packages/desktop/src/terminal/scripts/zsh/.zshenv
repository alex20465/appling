# Appling Desktop shell integration: ZDOTDIR points to this folder, so zsh reads this file instead of the user's
# .zshenv. It reads the user's own file from the user's ZDOTDIR (which that file may change) and comes back here.
__appling_zdotdir=$ZDOTDIR
ZDOTDIR=${APPLING_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshenv ]] && builtin source $ZDOTDIR/.zshenv
APPLING_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__appling_zdotdir
builtin unset __appling_zdotdir
