#!/bin/bash
# Adds public keys to the fixture account's ~/.ssh/authorized_keys in a running fixture container:
#   authorize.sh <container> <key.pub>...
# emulator-run.sh authorizes the test-only keys of app/android/app/src/test/resources/ssh-test-keys
# this way (all but rsa-pem, which the instrumented test expects refused).
set -euo pipefail
name=$1
shift
for pub in "$@"; do
  docker exec -i -u fixture "$name" sh -c 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < "$pub"
done
docker exec -u fixture "$name" sh -c 'chmod 600 ~/.ssh/authorized_keys; wc -l < ~/.ssh/authorized_keys'
