FROM ubuntu:24.04

# entrypoint.sh registers with --disableupdate: raise this within 30 days of a new actions/runner release
ARG RUNNER_VERSION=2.338.2
ARG RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
ARG GH_VERSION=2.102.0
ARG GH_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
# Keep in sync with playwright-core in bun.lock.
ARG PLAYWRIGHT_VERSION=1.63.0
ARG BUN_VERSION=1.4.4
ARG BUN_SHA256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
ARG NODE_VERSION=22.23.3
ARG NODE_SHA256=1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af
ARG HERDR_VERSION=0.9.3
ARG HERDR_SHA256=18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq unzip xz-utils tar ffmpeg python3 tini \
      openssh-client openssh-server iproute2 binutils tmux procps \
 && mkdir -p /run/sshd \
 && rm -rf /var/lib/apt/lists/*

# Install fixed Bun and Node releases system-wide so the unprivileged runner can use them.
RUN curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
 && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/bun.zip -d /tmp \
 && install -m 0755 /tmp/bun-linux-x64/bun /usr/local/bin/bun \
 && ln -s /usr/local/bin/bun /usr/local/bin/bunx \
 && rm -rf /tmp/bun.zip /tmp/bun-linux-x64

RUN curl -fsSL -o /tmp/node.tar.gz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
 && tar xzf /tmp/node.tar.gz -C /usr/local/lib \
 && ln -s "/usr/local/lib/node-v${NODE_VERSION}-linux-x64/bin/node" /usr/local/bin/node \
 && ln -s "/usr/local/lib/node-v${NODE_VERSION}-linux-x64/bin/npm" /usr/local/bin/npm \
 && ln -s "/usr/local/lib/node-v${NODE_VERSION}-linux-x64/bin/npx" /usr/local/bin/npx \
 && ln -s "/usr/local/lib/node-v${NODE_VERSION}-linux-x64/bin/corepack" /usr/local/bin/corepack \
 && rm /tmp/node.tar.gz

RUN curl -fsSL -o /tmp/herdr \
      "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-x86_64" \
 && echo "${HERDR_SHA256}  /tmp/herdr" | sha256sum -c - \
 && install -m 0755 /tmp/herdr /usr/local/bin/herdr \
 && rm /tmp/herdr

RUN useradd --create-home --uid 1001 --shell /bin/bash runner \
 && mkdir -p /home/runner/actions-runner \
 && curl -fsSL -o /tmp/runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
 && echo "${RUNNER_SHA256}  /tmp/runner.tar.gz" | sha256sum -c - \
 && tar xzf /tmp/runner.tar.gz -C /home/runner/actions-runner \
 && rm /tmp/runner.tar.gz \
 && curl -fsSL -o /tmp/gh.tar.gz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum -c - \
 && tar xzf /tmp/gh.tar.gz -C /tmp \
 && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_amd64" \
 && gh --version \
 && apt-get update \
 && /home/runner/actions-runner/bin/installdependencies.sh \
 && rm -rf /var/lib/apt/lists/* \
 && chown -R runner:runner /home/runner

# Chromium and its system libraries are installed as root at build time so jobs never need sudo.
RUN bunx playwright-core@${PLAYWRIGHT_VERSION} install-deps chromium \
 && bunx playwright-core@${PLAYWRIGHT_VERSION} install chromium \
 && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}" \
 && rm -rf /root/.bun /root/.cache /var/lib/apt/lists/*

# Jobs check out under /w: check.ts puts herdr's socket under the workspace's .ci/, and a unix
# socket path is limited to about 100 bytes (the default _work under actions-runner is too long).
RUN mkdir /w && chown runner:runner /w

COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

# Runs before every job, outside the workflow's control: fork code never runs here (job-started.sh).
COPY job-started.sh /opt/runner-hooks/job-started.sh
RUN chmod 0755 /opt/runner-hooks/job-started.sh
ENV ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/runner-hooks/job-started.sh

USER runner
ENV USER=runner
WORKDIR /home/runner/actions-runner
ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
