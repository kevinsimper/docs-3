/**
 * Copyright 2019 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const gulp = require('gulp');
const {sh} = require('@lib/utils/sh');
const config = require('@lib/config');
const del = require('del');
const {samplesBuilder} = require('@lib/build/samplesBuilder');
const {project, travis} = require('@lib/utils');
const ComponentReferenceImporter = require('@lib/pipeline/componentReferenceImporter');
const SpecImporter = require('@lib/pipeline/specImporter');
const roadmapImporter = require('@lib/pipeline/roadmapImporter');
const {pageTransformer} = require('@lib/build/pageTransformer');
const gulpSass = require('gulp-sass');

// The Google Cloud Storage bucket used to store build job artifacts
const TRAVIS_GCS_PATH = 'gs://amp-dev-ci/travis/';

// Local path to the archive containing artifacts of the first stage
const SETUP_ARCHIVE = 'build/setup.zip';
// All paths that contain altered files at build setup time
const SETUP_STORED_PATHS = [
  'pages/content',
  project.paths.DIST,
  'boilerplate/dist',
  'playground/dist',
  '.cache',
  'examples/static/samples/samples.json',
];

/**
 * Cleans all directories/files that get created by any of the following
 * tasks
 *
 * @return {Promise}
 */
function clean() {
  return del([
    project.absolute('.cache/**/*'),

    project.paths.DIST,
    project.paths.BUILD,

    project.absolute('boilerplate/dist'),

    project.paths.CSS,
    project.absolute('pages/extensions/**/*.pyc'),
    project.absolute('pages/content/amp-dev/documentation/examples/documentation/**/*.html'),
    project.absolute('pages/content/amp-dev/documentation/examples/previews/**/*.html'),
    project.absolute('pages/icons'),
    project.absolute('pages/layouts'),
    project.absolute('pages/macros'),
    project.absolute('pages/views'),
    project.absolute('pages/.depcache.json'),
    project.absolute('pages/podspec.yaml'),

    project.paths.GROW_BUILD_DEST,
    project.absolute('platform/static'),

    project.absolute('playground/dist'),
  ], {'force': true});
}


/**
 * Compiles all SCSS partials to CSS
 *
 * @return {Stream}
 */
function _sass() {
  const options = {
    'outputStyle': 'compressed',
    'includePaths': project.paths.SCSS,
  };

  return gulp.src(project.paths.SCSS)
      .pipe(gulpSass(options))
      .on('error', function(e) {
        console.error(e);
        // eslint-disable-next-line no-invalid-this
        this.emit('end');
      })
      .pipe(gulp.dest(project.paths.CSS));
}

/**
 * Copies the templates into the Grow pod
 *
 * @return {Stream}
 */
function _templates() {
  return gulp.src(project.absolute('frontend/templates/**/*'))
      .pipe(gulp.dest(project.paths.GROW_POD));
}

/**
 * Copies the icons into the Grow pod
 *
 * @return {Stream}
 */
function _icons() {
  return gulp.src(project.absolute('frontend/icons/**/*'))
      .pipe(gulp.dest(`${project.paths.GROW_POD}/icons`));
}

/**
 * Runs all tasks needed to build the frontend
 * @return {undefined}
 */
function buildFrontend(callback) {
  return (gulp.parallel(_sass, _templates, _icons))(callback);
}

/**
 * Builds the playground
 * @return {Promise}
 */
function buildPlayground() {
  return sh('npm run build:playground');
}

/**
 * Builds the boilerplate generator
 * @return {Promise}
 */
function buildBoilerplate() {
  return sh('node build.js', {
    workingDir: project.absolute('boilerplate'),
  });
}


/**
 * Builds documentation pages, preview pages and source files by parsing
 * the samples sources
 *
 * @return {Promise}
 */
function buildSamples() {
  return samplesBuilder.build(true);
}


/**
 * Runs all importers
 *
 * @return {Promise}
 */
function importAll() {
  return Promise.all([
    (new ComponentReferenceImporter()).import(),
    (new SpecImporter()).import(),
    // TODO: Fails on Travis with HttpError: Requires authentication
    // roadmapImporter.importRoadmap(),
  ]);
}


/**
 * Builds playground and boilerplate generator, imports all remote documents,
 * builds samples, lints Grow pod and JavaScript.
 *
 * @return {Promise}
 */
async function setupBuild() {
  await sh('npm run lint:node');

  // Those two are built that early in the flow as they are fairly quick
  // to build and would be annoying to eventually fail downstream
  await Promise.all([buildPlayground(), buildBoilerplate()]);

  await Promise.all([buildSamples(), importAll()]);

  // Grow can only be linted after samples have been built and possibly linked
  // to pages have been imported
  // TODO: Reenable after false-positives have been fixed
  // await sh('npm run lint:grow');

  // If on Travis store everything built so far for later stages to pick up
  if (travis.onTravis()) {
    await sh('mkdir -p build');
    await sh(`zip -r ${SETUP_ARCHIVE} ${SETUP_STORED_PATHS.join(' ')}`);
    await sh(`gsutil cp ${SETUP_ARCHIVE} ` +
      `${TRAVIS_GCS_PATH}${travis.build.number}/${SETUP_ARCHIVE}`);
  }
}

/**
 * Starts Grow to build the pages
 *
 * @return {Promise}
 */
async function buildPages() {
  // If building on Travis fetch artifacts built in previous stages
  if (travis.onTravis()) {
    await sh(`gsutil cp ${TRAVIS_GCS_PATH}${travis.build.number}/${SETUP_ARCHIVE}` +
      ` ${SETUP_ARCHIVE}`);
    await sh(`unzip -o -q -d . ${SETUP_ARCHIVE}`);
  }

  config.configureGrow();
  await sh('grow deploy --noconfirm --threaded', {
    workingDir: project.paths.GROW_POD,
  });

  // After the pages have been built by Grow create transformed versions
  await pageTransformer.start(project.paths.GROW_BUILD_DEST);

  // ... and again if on Travis store all built files for a later stage to pick up
  if (travis.onTravis()) {
    const archive = `build/pages-${travis.build.job}.zip`;
    await sh(`zip -r ${archive} dist/pages`);
    await sh(`gsutil cp ${archive}` +
      `${TRAVIS_GCS_PATH}${travis.build.number}/pages-${travis.build.job}.zip`);
  }
}

/**
 * Finalizes a build by fetching eventual remote artifacts and executing final
 * build step like collecting the static files before building a docker image
 *
 * @return {Promise}
 */
async function finalizeBuild() {
  // If building on Travis fetch artifacts built in previous stages
  if (travis.onTravis()) {
    await sh(`gsutil cp -r ${TRAVIS_GCS_PATH}${travis.build.number} ${project.paths.BUILD}`);
    await sh('find build -type f -exec unzip -o -q -d . {} \;');
  }
}

exports.clean = clean;
exports.importAll = importAll;
exports.buildFrontend = buildFrontend;
exports.buildSamples = buildSamples;
exports.buildPages = buildPages;

exports.setupBuild = setupBuild;
exports.build = gulp.series(buildFrontend, buildPages);
exports.finalizeBuild = finalizeBuild;
