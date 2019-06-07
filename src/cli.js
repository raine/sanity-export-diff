const meow = require('meow')
const decompress = require('decompress')
const ora = require('ora')
const { processLineByLine } = require('./util')
const deepDiff = require('deep-diff')
const fs = require('fs')
const path = require('path')
const md5File = require('md5-file')

const cli = meow(`
  About
    Tool for exporting and comparing Sanity datasets.
    This tool will create files and folders in current directory.

  Usage
    $ sanity-export-diff <dataset path A> <dataset path B>
  Options
    --help Show this help
  Examples
    # Compare dataset 'production' with dataset 'staging' in project abcdef1
    $ sanity-export-diff ../prod.tar.gz ../staging.tar.gz
`,
  {
    boolean: [],
    alias: {
    }
  }
)

const { input, showHelp } = cli

if (input.length !== 2) {
  showHelp()
  process.exit(1)
}

cli.input.forEach((input) => {
  if (!fs.existsSync(input)) {
    console.log('No such file or directory: ' + input)
    process.exit(1)
  }
})

async function doDecompress(path, destination = process.cwd()) {
  const spinner = ora(`Decompressing ${path}`).start()
  return decompress(path, destination)
    .then((res) => {
      spinner.succeed()
      const ndjson = res.find(data => data.path.endsWith('data.ndjson'))
      if (!ndjson) {
        throw new Error('No data.ndjson in archive')
      }
      return ndjson.path
    })
    .catch((err) => spinner.fail(err.msg))
}

const ignore = ['_rev', '_updatedAt', '_key', '_createdAt']

const clone = (val) => {
  if (Array.isArray(val)) {
    return val.map(clone)
  } else if (typeof val === 'object') {
    const c = {}
    Object.keys(val).forEach((key) => {
      if (!ignore.includes(key)) {
        c[key] = clone(val[key])
      }
    })

    return c
  }

  return val
}

Array.prototype.groupBy = function(prop) {
  return this.reduce(function(groups, item) {
    const val = item[prop]
    groups[val] = groups[val] || []
    groups[val].push(item)
    return groups
  }, {})
}

Object.filter = (obj, predicate) =>
  Object.keys(obj)
    .filter(key => predicate(obj[key]))
    .reduce((res, key) => (res[key] = obj[key], res), {})


async function compare(a, b) {
  const spinner = ora('Comparing datasets').start()

  const aO = await processLineByLine(a)
  const bO = await processLineByLine(b)
  const aIds = aO.map(o => o._id)
  const bIds = bO.map(o => o._id)
  const added = []
  const removed = []

  const objects = {}
  const createIfMissing = type => {
    if (!objects[type]) {
      objects[type] = {
        added: [],
        removed: [],
        changed: [],
      }
    }
  }

  const noDifference = []
  aO.forEach((obj) => { 
    const rhs = bO.find(b => b._id === obj._id)
    if (rhs === undefined) {
      // Removed
      createIfMissing(obj._type)
      objects[obj._type].removed.push(obj._id)
      noDifference.push(obj._id)
    }
  })

  bO.forEach((obj) => { 
    const lhs = aO.find(a => a._id === obj._id)
    if (lhs === undefined) {
      // Added
      createIfMissing(obj._type)
      objects[obj._type].added.push(obj._id)
      noDifference.push(obj._id)
    }
  })

  const assetHashes = {}
  const pathA = path.parse(a)
  const pathB = path.parse(b)

  aO.filter(o => !noDifference.includes(o._id))
    .forEach((obj) => {
      const bObj = bO.find(o => o._id === obj._id)
      if (!bObj) {
        spinner.fail()
        throw new Error('whops, should have been here')
      }

      const aCmp = clone(obj)
      const bCmp = clone(bObj)

      const d = deepDiff(aCmp, bCmp)
      if (d) {
        const diff = d
          .filter(x => !ignore.includes(x.path))
          .filter((x) => {
            if (x.path[x.path.length - 1] === '_sanityAsset') {
              if (x.kind === 'E') {
                // Asset changed. Check if its the same file
                const fA = `${pathA.dir}/${x.lhs.replace('image@file://./', '')}`
                if (!assetHashes[fA]) {
                  assetHashes[fA] = md5File.sync(fA)
                }
                const fB = `${pathB.dir}/${x.rhs.replace('image@file://./', '')}`
                if (!assetHashes[fB]) {
                  assetHashes[fB] = md5File.sync(fB)
                }
                return assetHashes[fA] !== assetHashes[fB]
              }
            }

            return true
          })

        if (diff.length) {
          // Changed
          createIfMissing(obj._type)
          objects[obj._type].changed.push({
            id: obj._id,
            diff
          })
        }
      }
  })

  fs.writeFileSync('web/data.json', JSON.stringify(objects))
  spinner.succeed()
}

function dataFilePath(dir) {
  if (dir.endsWith('/')) {
    return dir + 'data.ndjson'
  }
  return dir + '/data.ndjson'
}

function isDir(path) {
  return fs.lstatSync(path).isDirectory()
}

async function run(paths) {
  const dataA = isDir(paths[0]) ? dataFilePath(paths[0]) : await doDecompress(paths[0])
  const dataB = isDir(paths[1]) ? dataFilePath(paths[1]) : await doDecompress(paths[1])
  compare(dataA, dataB)
}

run(cli.input)