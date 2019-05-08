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
const signale = require('signale');
const del = require('del');
const fs = require('fs');
const path = require('path');
const through = require('through2');
const archiver = require('archiver');
const yaml = require('js-yaml');
const {samplesBuilder} = require('@lib/build/samplesBuilder');
const {project, travis} = require('@lib/utils');
const git = require('@lib/utils/git');
const ComponentReferenceImporter = require('@lib/pipeline/componentReferenceImporter');
const SpecImporter = require('@lib/pipeline/specImporter');
// TODO: Fails on Travis with HttpError: Requires authentication
// const roadmapImporter = require('@lib/pipeline/roadmapImporter');
const {pageTransformer} = require('@lib/build/pageTransformer');
const gulpSass = require('gulp-sass');

// The Google Cloud Storage bucket used to store build job artifacts
const TRAVIS_GCS_PATH = 'gs://amp-dev-ci/travis/';

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
    project.paths.STATICS_DEST,
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

  return gulp.src(`${project.paths.SCSS}/**/[^_]*.scss`)
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
  // Local path to the archive containing artifacts of the first stage
  const SETUP_ARCHIVE = 'build/setup.tar.gz';
  // All paths that contain altered files at build setup time
  const SETUP_STORED_PATHS = [
    './pages/content/',
    './dist/',
    './boilerplate/dist/',
    './playground/dist/',
    './.cache/',
    './examples/static/samples/samples.json',
  ];

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
    await sh(`tar cfj ${SETUP_ARCHIVE} ${SETUP_STORED_PATHS.join(' ')}`);
    await sh(`gsutil cp ${SETUP_ARCHIVE} ` +
      `${TRAVIS_GCS_PATH}${travis.build.number}/setup.tar.gz`);
  }
}

/**
 * Fetches remote artifacts that have been built in earlier stages
 *
 * @return {Promise}
 */
async function fetchArtifacts() {
  await sh('mkdir -p build');
  if (travis.onTravis()) {
    await sh(`gsutil cp -r ${TRAVIS_GCS_PATH}${travis.build.number} ${project.paths.BUILD}`);
    await sh('find build -type f -exec tar xf {} \;');
  }
}

/**
 * Starts Grow to build the pages
 *
 * @return {Promise}
 */
async function buildPages() {
  config.configureGrow();
  await sh('grow deploy --noconfirm --threaded', {
    workingDir: project.paths.GROW_POD,
  });

  // After the pages have been built by Grow create transformed versions
  await new Promise((resolve, reject) => {
    const stream = pageTransformer.start([
      `${project.paths.GROW_BUILD_DEST}/**/*.html`,
      `!${project.paths.GROW_BUILD_DEST}/shared/*.html`,
    ]);

    stream.on('end', resolve);
    stream.on('error', reject);
  });

  // ... and again if on Travis store all built files for a later stage to pick up
  if (travis.onTravis()) {
    const archive = `build/pages-${travis.build.job}.tar.gz`;
    await sh(`tar cfj ${archive} ./dist/pages`);
    await sh(`gsutil cp ${archive} ` +
      `${TRAVIS_GCS_PATH}${travis.build.number}/pages-${travis.build.job}.tar.gz`);
  }
}

/**
 * Collects the static files of all sub projcts to dist while creating ZIPs
 * from folders ending on .zip
 *
 * @return {Stream}
 */
function collectStatics(done) {
  // Used to keep track of unfinished archives
  const archives = {};

  gulp.src([
    project.absolute('pages/static/**/*'),
    project.absolute('examples/static/**/*'),
  ]).pipe(through.obj(async function(file, encoding, callback) {
    // Skip potential archive parent directories to have the path writable later
    if (file.stat.isDirectory() && file.path.endsWith('.zip')) {
      callback();
      return;
    }

    // Check if file could be part of a ZIP and not already is one itself
    if (file.path.includes('.zip') && !file.path.endsWith('.zip')) {
      // If the file should be part of a ZIP file pass it over to archiver
      const relativePath = file.relative.slice(0, file.relative.indexOf('.zip') + 4);
      const archive = archives[relativePath] || archiver('zip', {
        'zlib': {'level': 9},
      });

      // Only append real files, directories will be created automatically
      const filePath = file.relative.replace(relativePath, '');
      if (!file.stat.isDirectory() && filePath) {
        archive.append(file.contents, {'name': filePath});
      }

      archives[relativePath] = archive;
      callback();
      return;
    }

    // ... and simply copy all other files
    // eslint-disable-next-line no-invalid-this
    this.push(file);
    callback();
  }))
      .pipe(gulp.dest(project.paths.STATICS_DEST))
      .on('end', async () => {
        signale.await('Writing ZIPs ...');

        const writes = [];
        for (const [archivePath, contents] of Object.entries(archives)) {
          contents.finalize();

          const dest = path.join(project.paths.STATICS_DEST, archivePath);
          const archive = fs.createWriteStream(dest);

          writes.push(new Promise((resolve, reject) => {
            contents.pipe(archive).on('close', () => {
              signale.success(`Wrote archive ${archivePath}`);
              resolve();
            });
          }));
        };

        await Promise.all(writes);
        signale.await('Finished collecting static files!');
        done();
      });
}

/**
 * Writes information about the current build to a file to be able to
 * inspect the current version on /who-am-i
 *
 * @return {undefined}
 */
function persistBuildInfo(done) {
  const buildInfo = {
    'timestamp': new Date(),
    'number': travis.build.number || null,
    'environment': config.environment,
    'commit': {
      'sha': git.version,
      'message': git.message,
    },
    'by': git.user,
  };

  fs.writeFile(project.paths.BUILD_INFO, yaml.safeDump(buildInfo), done);
}

exports.clean = clean;
exports.importAll = importAll;
exports.buildFrontend = buildFrontend;
exports.buildSamples = buildSamples;
exports.buildPages = buildPages;

exports.setupBuild = setupBuild;
exports.build = gulp.series(fetchArtifacts, gulp.parallel(buildSamples, buildFrontend), buildPages);
exports.collectStatics = collectStatics;
exports.finalizeBuild = gulp.parallel(fetchArtifacts, collectStatics, persistBuildInfo);
