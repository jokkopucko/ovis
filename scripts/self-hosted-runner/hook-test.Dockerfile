# The hook kill tests' throwaway image (.github/workflows/hook-kill-tests.yml, scripts/self-hosted-runner/hook-test-container.sh).
# NOT the runner image: no runner, no job ever runs here. It holds what the isolated tests of
# scripts/self-hosted-runner.test.ts need (bash, jq, procps, python3, Bun at the version .github/actions/setup-ci sets)
# and the marker that hook-test-harness.sh's container guard requires: /opt/runner-hooks/ovis-runner-image, a regular
# file owned by root, mode 0444, in a root-owned directory, which the tests' user cannot write. The guard also needs
# docker-init as PID 1: the container is started with `docker run --init`.
FROM oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq procps python3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1001 --shell /bin/bash hooktest \
 && mkdir -p /opt/runner-hooks \
 && printf 'ovis hook kill tests image\n' >/opt/runner-hooks/ovis-runner-image \
 && chmod 0755 /opt/runner-hooks \
 && chmod 0444 /opt/runner-hooks/ovis-runner-image

USER hooktest
WORKDIR /home/hooktest
