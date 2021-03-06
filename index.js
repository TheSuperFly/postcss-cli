'use strict'

const fs = require('fs-extra')
const path = require('path')

const ora = require('ora')
const prettyHrtime = require('pretty-hrtime')
const stdin = require('get-stdin')
const read = require('read-cache')
const chalk = require('chalk')
const globber = require('globby')
const chokidar = require('chokidar')

const postcss = require('postcss')
const postcssrc = require('postcss-load-config')
const reporter = require('postcss-reporter/lib/formatter')()

const argv = require('./lib/args')
const depGraph = require('./lib/depGraph')

const dir = argv.dir

let input = argv._
const output = argv.output

if (argv.map) argv.map = { inline: false }

const spinner = ora()

let config = {
  options: {
    map: argv.map !== undefined ? argv.map : { inline: true },
    parser: argv.parser ? require(argv.parser) : undefined,
    syntax: argv.syntax ? require(argv.syntax) : undefined,
    stringifier: argv.stringifier ? require(argv.stringifier) : undefined
  },
  plugins: argv.use
    ? argv.use.map(plugin => {
        try {
          return require(plugin)()
        } catch (e) {
          return error(`Plugin Error: Cannot find module '${plugin}'`)
        }
      })
    : []
}

if (argv.env) process.env.NODE_ENV = argv.env
if (argv.config) argv.config = path.resolve(argv.config)

Promise.resolve()
  .then(() => {
    if (input && input.length) return globber(input)

    if (argv.replace || argv.dir) {
      error(
        'Input Error: Cannot use --dir or --replace when reading from stdin'
      )
    }

    if (argv.watch) {
      error('Input Error: Cannot run in watch mode when reading from stdin')
    }

    return ['stdin']
  })
  .then(i => {
    if (!i || !i.length) {
      error('Input Error: You must pass a valid list of files to parse')
    }

    if (i.length > 1 && !argv.dir && !argv.replace && !output) {
      error(
        'Input Error: Must use --dir or --replace with multiple input files'
      )
    }

    if (i[0] !== 'stdin') i = i.map(i => path.resolve(i))

    input = i

    truncateDestinationFile()

    return files(input)
  })
  .then(results => {
    if (argv.watch) {
      const watcher = chokidar.watch(input.concat(dependencies(results)), {
        usePolling: argv.poll,
        interval: argv.poll && typeof argv.poll === 'number' ? argv.poll : 100
      })

      if (config.file) watcher.add(config.file)

      watcher
        .on('ready', () => {
          console.warn(chalk.bold.cyan('Waiting for file changes...'))
        })
        .on('change', file => {
          let recompile = []

          if (!shouldAppendCSS()) {
            if (~input.indexOf(file)) recompile.push(file)

            recompile = recompile.concat(
              depGraph.dependantsOf(file).filter(file => ~input.indexOf(file)),
            )
          } else {
            truncateDestinationFile()
          }

          if (!recompile.length) recompile = input

          return files(recompile)
            .then(results => watcher.add(dependencies(results)))
            .then(() => {
              console.warn(chalk.bold.cyan('Waiting for file changes...'))
            })
            .catch(error)
        })
    }
  })
  .catch(error)

function rc(ctx, path) {
  if (argv.use) return Promise.resolve()

  // Set argv: false to keep cosmiconfig from attempting to read the --config
  // flag from process.argv
  return postcssrc(ctx, path, { argv: false })
    .then(rc => {
      if (rc.options.from || rc.options.to) {
        error(
          'Config Error: Can not set from or to options in config file, use CLI arguments instead'
        )
      }
      config = rc
    })
    .catch(err => {
      if (err.message.indexOf('No PostCSS Config found') === -1) throw err
    })
}

function files(files) {
  if (typeof files === 'string') files = [files]

  const appendCSS = shouldAppendCSS()

  return Promise.all(
    files.map(file => {
      if (file === 'stdin') {
        return stdin().then(content => {
          if (!content) return error('Input Error: Did not receive any STDIN')
          return css(content, 'stdin')
        })
      }

      return read(file).then(content => css(content, file, appendCSS))
    })
  )
}

function css(css, file, appendCSS) {
  const ctx = { options: config.options }

  if (file !== 'stdin') {
    ctx.file = {
      dirname: path.dirname(file),
      basename: path.basename(file),
      extname: path.extname(file)
    }

    if (!argv.config) argv.config = path.dirname(file)
  }

  const relativePath =
    file !== 'stdin' ? path.relative(path.resolve(), file) : file

  if (!argv.config) argv.config = process.cwd()

  const time = process.hrtime()

  spinner.text = `Processing ${relativePath}`
  spinner.start()

  return rc(ctx, argv.config)
    .then(() => {
      const options = config.options

      if (file === 'stdin' && output) file = output

      // TODO: Unit test this
      options.from = file === 'stdin' ? path.join(process.cwd(), 'stdin') : file

      if (output || dir || argv.replace) {
        const base = argv.base
          ? file.replace(path.resolve(argv.base), '')
          : path.basename(file)
        options.to = output || (argv.replace ? file : path.join(dir, base))

        if (argv.ext) {
          options.to = options.to.replace(path.extname(options.to), argv.ext)
        }

        options.to = path.resolve(options.to)
      }

      if (!options.to && config.options.map && !config.options.map.inline) {
        spinner.fail()
        error(
          'Output Error: Cannot output external sourcemaps when writing to STDOUT'
        )
      }

      return postcss(config.plugins)
        .process(css, options)
        .then(result => {
          const tasks = []

          if (options.to) {
            if (appendCSS) {
              tasks.push(fs.appendFile(options.to, result.css))
            } else {
              tasks.push(fs.outputFile(options.to, result.css))
            }

            if (result.map) {
              tasks.push(
                fs.outputFile(
                  options.to.replace(
                    path.extname(options.to),
                    `${path.extname(options.to)}.map`
                  ),
                  result.map
                )
              )
            }
          } else {
            spinner.text = chalk.bold.green(
              `Finished ${relativePath} (${prettyHrtime(process.hrtime(time))})`
            )
            spinner.succeed()
            return process.stdout.write(result.css, 'utf8')
          }

          return Promise.all(tasks).then(() => {
            spinner.text = chalk.bold.green(
              `Finished ${relativePath} (${prettyHrtime(process.hrtime(time))})`
            )
            if (result.warnings().length) {
              spinner.fail()
              console.warn(reporter(result))
            } else spinner.succeed()

            return result
          })
        })
    })
    .catch(err => {
      spinner.fail()
      throw err
    })
}

function dependencies(results) {
  if (!Array.isArray(results)) results = [results]

  const messages = []

  results.forEach(result => {
    if (result.messages <= 0) return

    result.messages
      .filter(msg => (msg.type === 'dependency' ? msg : ''))
      .map(depGraph.add)
      .forEach(dependency => messages.push(dependency.file))
  })

  return messages
}

function error(err) {
  if (typeof err === 'string') {
    spinner.fail(chalk.bold.red(err))
  } else if (err.name === 'CssSyntaxError') {
    console.error('\n')

    spinner.text = spinner.text.replace('Processing ', '')
    spinner.fail(chalk.bold.red(`Syntax Error: ${spinner.text}`))

    if (err.file) {
      err.message = err.message.substr(err.file.length + 1)
    } else {
      err.message = err.message.replace('<css input>:', '')
    }

    err.message = err.message.replace(/:\s/, '] ')

    console.error('\n', chalk.bold.red(`[${err.message}`))
    console.error('\n', err.showSourceCode(), '\n\n')

    if (argv.watch) return
  } else {
    console.error(err)
  }
  process.exit(1)
}

function shouldAppendCSS() {
  const hasOutputFile = !!argv.output
  const hasMultipleFiles = (input.length > 1)

  return hasMultipleFiles && hasOutputFile
}

function truncateDestinationFile() {
  Promise.resolve()
    .then(() => {
      return fs.pathExists(output)
    })
    .then((exists) => {
      if (exists) {
        fs.truncate(output, err => {
          if (err) return error('Output Error : Cannot truncate output file.')
        })
      }
    })
    .catch(ex => {
      return error(ex);
    })
}