# Appling Desktop shell integration: zsh reads this file instead of the user's .zlogin, which it reads in turn.
# It is the last startup file of a login shell: from now on ZDOTDIR is the user's again.
ZDOTDIR=${APPLING_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zlogin ]] && builtin source $ZDOTDIR/.zlogin
builtin unset APPLING_USER_ZDOTDIR
