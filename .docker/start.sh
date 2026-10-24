#!/bin/bash

###### envs #######
echo "###### Starting envs ######"
if [ ! -f "./.env" ]; then
    cp ./.env.example ./.env
fi

mkdir -p ./.docker/bash

npm install

tail -f /dev/null
