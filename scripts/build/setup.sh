#!/bin/bash
#
# Copyright 2019 The AMP HTML Authors. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS-IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the license.

GREEN() { echo -e "\033[1;32m$1\033[0m"; }
CYAN() { echo -e "\033[1;36m$1\033[0m"; }

# Exit if one of the below commands fails
set -e

cd $(dirname $0)/../..

root=$(pwd)
args=$*

# Linting platform code
echo $(CYAN "Linting node ...")
echo -e "travis_fold:start:lint-node\n"
cd $root && npm run lint:node
echo -e "travis_fold:end:lint-node\n"
echo $(GREEN "Linted node!")

# Build boilerplate
echo $(CYAN "Building boilerplate generator ...")
echo -e "travis_fold:start:boilerplate\n"
cd $root/boilerplate && node build.js
echo -e "travis_fold:end:boilerplate\n"
echo $(GREEN "Built boilerplate generator!")

# Build playground
echo $(CYAN "Building playground ...")
echo -e "travis_fold:start:playground\n"
cd $root && npm run build:playground
echo -e "travis_fold:end:playground\n"
echo $(GREEN "Built playground!")

# Build samples
echo $(CYAN "Building samples ...")
echo -e "travis_fold:start:samples\n"
cd $root && node platform/lib/build/samplesBuilder.js
echo -e "travis_fold:end:samples\n"
echo $(GREEN "Built samples!")

# Import documents
echo $(CYAN "Importing documents ...")
echo -e "travis_fold:start:import\n"
cd $root && node platform/lib/pipeline/componentReferenceImporter.js
cd $root && node platform/lib/pipeline/specImporter.js
cd $root && node platform/lib/pipeline/roadmapImporter.js
echo -e "travis_fold:end:import\n"
echo $(GREEN "Imported documents!")

# Checking for broken references in Grow can only be done after samples have
# been built and all documents have been imported
echo $(CYAN "Checking document references ...")
echo -e "travis_fold:start:lint-grow\n"
cd $root && npm run lint:grow
echo -e "travis_fold:end:lint-grow\n"
echo $(GREEN "Checked document references!")

# Store new (built or imported) data in GCS if on Traivs
if [ -n "$TRAVIS_BUILD_NUMBER" ]; then
  echo $(CYAN "Storing artifacts in Google Cloud Storage ...")
  echo -e "travis_fold:start:store\n"
  cd $root
  mkdir -p artifacts

  # ZIP artifacts to speed up transfer
  zip -r artifacts/setup.zip pages/content dist boilerplate/dist playground/dist .cache examples/static/samples/samples.json
  gsutil cp $root/artifacts/setup.zip gs://us.artifacts.amp-dev-staging.appspot.com/travis/$TRAVIS_BUILD_NUMBER/setup.zip
  echo -e "travis_fold:end:store\n"
fi
