# The systemd image of the trial join's container test (scripts/join/join.contract.test.ts, case 1), which builds it as
# ovis-join-systemd:local when missing: the CI runner image (scripts/self-hosted-runner) with systemd as PID 1 and a user
# manager, the account `ovis` the join runs as, and no Bun or Node on the machine.
FROM herdr-ci-runner:local
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session libpam-systemd \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /usr/local/bin/bun /usr/local/bin/node /usr/local/bin/bunx /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
  && useradd -m -s /bin/bash ovis \
  && systemctl mask systemd-networkd.service systemd-resolved.service systemd-timesyncd.service getty@tty1.service console-getty.service
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/sbin/init"]
