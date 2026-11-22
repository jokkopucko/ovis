# Disposable SSH fixture for the Android SSH prototype: sshd + herdr + an Ovis server + a stand-in
# Claude agent, all inside one container. Built by up.sh from a staged context; never pushed.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=xterm-256color

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server python3 procps git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# test-only account and password (named in up.sh); the container's sshd is bound to host loopback only
RUN useradd -m -s /bin/bash fixture \
  && echo 'fixture:phone-ssh-test-only' | chpasswd

COPY sshd_config /etc/ssh/sshd_config.d/10-phone-ssh-fixture.conf
# host keys are made once here, so every container of this image shows the same host key
# (rekey.sh replaces them inside a running container to simulate a changed host key)
RUN rm -f /etc/ssh/ssh_host_* && ssh-keygen -A && mkdir -p /run/sshd

COPY bin/herdr /usr/local/bin/herdr
COPY bin/bun /usr/local/bin/bun
COPY claude-standin.py /usr/local/bin/claude
COPY entrypoint.sh start-fixture.sh /opt/phone-ssh/
COPY --chown=fixture:fixture ovis /opt/ovis
RUN chmod 755 /usr/local/bin/herdr /usr/local/bin/bun /usr/local/bin/claude /opt/phone-ssh/*.sh

EXPOSE 22
ENTRYPOINT ["/opt/phone-ssh/entrypoint.sh"]
