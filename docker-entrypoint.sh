#!/bin/sh
set -e

if [ "$1" = "proxy-auth" ]; then
  shift
  exec proxy-auth "$@"
fi

case "$1" in
  login|import|status)
    exec proxy-auth "$@"
    ;;
esac

exec "$@"
