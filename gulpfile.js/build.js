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
const {project} = require('@lib/utils');
const ComponentReferenceImporter = require('@lib/pipeline/componentReferenceImporter');
const SpecImporter = require('@lib/pipeline/specImporter');
const roadmapImporter = require('@lib/pipeline/roadmapImporter');
const gulpSass = require('gulp-sass');
const stripCssComments = require('gulp-strip-css-comments');

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
function sass() {
  const options = {
    'outputStyle': 'compressed',
    'includePaths': project.paths.SCSS,
  };

  return gulp.src(project.paths.SCSS)
    .pipe(gulpSass(options))
    .on('error', function(e) {
      console.error(e);
      this.emit('end');
    })
    .pipe(gulp.dest(project.paths.CSS));
}

/**
 * Copies the templates into the Grow pod
 *
 * @return {Stream}
 */
function templates() {
  return gulp.src(project.absolute('frontend/templates/**/*'))
    .pipe(gulp.dest(project.paths.GROW_POD));
}

/**
 * Copies the icons into the Grow pod
 *
 * @return {Stream}
 */
function icons() {
  return gulp.src(project.absolute('frontend/icons/**/*'))
    .pipe(gulp.dest(`${project.paths.GROW_POD}/icons`));
}


/**
 * Builds documentation pages, preview pages and source files by parsing
 * the samples sources
 *
 * @return {Promise}
 */
function samples() {
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
function pages() {
  return sh('grow deploy --noconfirm --threaded', {
    workingDir: project.paths.GROW_POD
  });
}

exports.clean = clean;
exports.importAll = importAll;
exports.frontend = gulp.parallel(sass, templates, icons);
exports.samples = samples;
exports.pages = pages;
