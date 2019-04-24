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
const _ = require('@lib/config');
const del = require('del');
const {samplesBuilder} = require('@lib/build/samplesBuilder');
const {project} = require('@lib/utils');
const ComponentReferenceImporter = require('@lib/pipeline/componentReferenceImporter');
const SpecImporter = require('@lib/pipeline/specImporter');
const roadmapImporter = require('@lib/pipeline/roadmapImporter');
const {pageTransformer} = require('@lib/build/pageTransformer');
const gulpSass = require('gulp-sass');

/**
 * Cleans all directories/files that get created by any of the following
 * tasks
 *
 * @return {Promise}
 */
function clean() {
  return del([
    project.absolute('.cache/**/*'),

    project.absolute('dist'),
    project.absolute('build'),

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
 * Runs all tasks needed to build the frontend
 * @return {Promise}
 */
function buildFrontend(callback) {
  return (gulp.parallel(_sass, _templates, _icons))(callback);
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
    roadmapImporter.importRoadmap(),
  ]);
}


/**
 * Starts Grow to build the pages
 */
async function buildPages() {
  await sh('grow deploy --noconfirm --threaded', {
    workingDir: project.paths.GROW_POD,
  });

  // After the pages have been built by Grow create transformed versions
  return pageTransformer.start(project.paths.GROW_BUILD_DEST);
}

async function prepareBuild() {
  await sh('npm run lint:node');

  // Those two are built that early in the flow as they are fairly quick
  // to build and would be annoying to eventually fail downstream
  await Promise.all([buildPlayground(), buildBoilerplate()]);

  await Promise.all([buildSamples(), importAll()]);

  // Grow can only be linted after samples have been built and possibly linked
  // to pages have been imported
  await sh('npm run lint:grow');

  // If on Travis store everything built so far for later stages to pick up
}

exports.clean = clean;
exports.importAll = importAll;
exports.buildFrontend = buildFrontend;
exports.buildSamples = buildSamples;
exports.buildPages = buildPages;

exports.prepareBuild = prepareBuild;
exports.build = gulp.series(buildFrontend, buildPages);
