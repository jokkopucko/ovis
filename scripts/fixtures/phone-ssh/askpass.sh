#!/bin/sh
# SSH_ASKPASS helper for the fixture's test-only password (used when sshpass is not installed):
#   SSH_ASKPASS=scripts/fixtures/phone-ssh/askpass.sh SSH_ASKPASS_REQUIRE=force ssh -p 2290 fixture@127.0.0.1
echo phone-ssh-test-only
