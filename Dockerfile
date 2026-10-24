FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    procps \
    bash \
    nano \
    sudo && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g @nestjs/cli && \
    npm cache clean --force

RUN echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER node

WORKDIR /home/node/app

# Histórico do bash persiste no host (pasta montada)
RUN echo 'HISTFILE=/home/node/app/.docker/bash/.bash_history' >> ~/.bashrc

CMD [ "tail", "-f", "/dev/null" ]
