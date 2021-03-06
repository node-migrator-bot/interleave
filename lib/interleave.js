var debug = require('debug')('interleave'),
    fs = require('fs'),
    path = require('path'),
    events = require('events'),
    util = require('util'),
    url = require('url'),
    async = require('async'),
    mkdirp = require('mkdirp'),
    out = require('out'),
    rigger = require('rigger'),
    findme = require('findme'),
    _ = require('underscore'),
    preprocessors = {},
    postprocessors = require('./postprocessors'),
    reStripExt = /\.(js)$/i,
    reTrailingSlash = /\/$/,
    reHidden = /^\./,
    reLeadingPaths = /^\..*\//,
    supportedExtensions = ['.js', '.css'];
    
/* # Helper Functions */

function _compile(interleaver, files, opts) {
    var combiner = require('./combiners')[opts.concat ? 'concat' : 'pass'],
        writeables = [];
    
    // flag the we are currently processing
    interleaver.processing = true;
    
    // iterate through the target files and read each one
    async.forEachSeries(
        files, 
        function(file, callback) {
            var realPath = path.resolve(interleaver.basedir, file),
                filetype = path.extname(realPath).slice(1);
            
            out('!{lime}<==          ' + file);
            
            fs.readFile(realPath, 'utf8', function(err, fileContents) {
                if (err) {
                    out('!{bold}error:!{red}       Could not include {0} :: ' + err, file);
                }
                else {
                    // set the rigger cwd
                    opts.cwd = path.dirname(realPath);

                    // initialise the filetype using the conversion type if it exists
                    opts.filetype = opts.conversions[filetype] || filetype;
                    debug('processing: ' + file + ', filetype = ' + opts.filetype);
                    
                    // process the file
                    rigger.process(fileContents, opts, function(err, source, settings) {
                        var sourceData;
                        
                        if (err) {
                            out('!{bold}error:!{red}       Could not include {0} :: ' + err, file);
                        }
                        else {
                            sourceData = {
                                file: file,
                                content: source
                            };
                            
                            // add the settings to the source data
                            for (var key in settings) {
                                if (! sourceData[key]) {
                                    sourceData[key] = settings[key];
                                }
                            }
                            
                            // create the source data for the writeables
                            writeables.push(sourceData);
                        }

                        callback(err, sourceData);
                    });
                }
            });
        }, 
        function(err) {
            if (! err) {
                // combine the files that have been processed by interleave
                combiner(interleaver, writeables, opts, function(files) {
                    interleaver.exportFiles(files, opts);
                });
            }
            else {
                interleaver.done();
            }
        }
    );
} // _compile

/*
## _expandPaths
The expandPaths function is used to take the input paths that have been supplied to 
interleaver and convert them to the discrete list of javascript files that was implied.
For instance, if a directory was supplied then this should be expanded to the .js files
that exist within the directory (without recursing into child directories).
*/
function _expandPaths(paths, callback) {
    var expandedPaths = [],
        basedir = this.basedir;
        
    function notHidden(file) {
        return !reHidden.test(file);
    }
    
    async.forEach(
        paths,
        function(inputPath, itemCallback) {
            debug('expanding path: ' + inputPath);
            
            // resolve the path against the base directory
            var realPath = path.resolve(basedir, inputPath);
            
            // first attempt to read the path as a directory
            fs.readdir(realPath, function(err, files) {
                // if it errored, then do an exists check on the file
                if (err) {
                    path.exists(realPath, function(exists) {
                        if (exists) {
                            debug('found file: ' + realPath);
                            expandedPaths.push(inputPath);
                        } // if
                        
                        itemCallback();
                    });
                }
                // otherwise, add each of the valid files in the directory to the expanded paths
                else {
                    debug('looking for files in: ' + realPath);
                    files.filter(notHidden).forEach(function(file) {
                        var stats = fs.statSync(path.join(realPath, file));
                        
                        if (stats.isFile()) {
                            expandedPaths.push(path.join(inputPath, file));
                        }
                    });
                    
                    // trigger the callback
                    itemCallback();
                }
            });
        },
        function(err) {
            callback(err, expandedPaths);
        }
    );
} // _expandPaths

/*
# Interleaver
The Interleaver is responsible for replacing interleave import statements (`//=`) with
the requested source.
*/
function Interleaver(opts) {
    var interleaver = this;
    
    // ensure we have options
    opts = opts || {};
    
    // set the targetpath file
    this.targetPath = path.resolve(opts.path || '.');
    this.targetFile = opts.output ? path.resolve(this.targetPath, opts.output) : '';
    
    // set the basedir that will be passed to the path.resolve when looking for files
    this.basedir = opts.basedir;
    this.processing = false;
    
    this.aliases = [];
    this.after = opts.after || [];
    this.data = opts.data || {};
    this.flags = {};
    
    // if we are linting then add 'lint' to the post-processors
    if (opts.lint && this.after.indexOf('lint') < 0) {
        this.after.push('lint');
    }
    
    // initialise the target packages
    this.targetPackages = [];
    
    // if we have been passed the opts.package option, then initialise the target packages
    if (opts['package']) {
        this.targetPackages = fs.readdirSync(path.resolve(__dirname, 'packagers'))
                .map(function(file) {
                    return path.basename(file, '.js');
                })
                .filter(function(packageType) {
                    // TODO: make configurable
                    return true;
                });
    }
    else if (opts.wrap) {
        this.targetPackages = [opts.wrap];
    }
    
    // initialise the flags
    (opts.flags || '').split(/\,/).forEach(function(flag) {
        interleaver.flags[flag] = true;
    });
    
    // iterate through the aliases and convert into regular expressions
    if (opts.aliases) {
        for (var key in opts.aliases) {
            this.aliases.push({
                regex: new RegExp('^' + key + '\\!(.*)$'),
                val: opts.aliases[key].replace(reTrailingSlash, '/$1')
            });
        } // for
    } // if

    // save the opts to the interleaver so plugins can access them
    this.opts = opts;
} // Interleaver

util.inherits(Interleaver, events.EventEmitter);

Interleaver.prototype._checkAliases = function(target) {
    // check to see if the target is an alias
    for (var ii = 0; ii < this.aliases.length; ii++) {
        var alias = this.aliases[ii];
        
        if (alias.regex.test(target)) {
            target = target.replace(alias.regex, alias.val);
        } // if
    } // for
    
    return target;
}; // _checkAliases

Interleaver.prototype._createPackages = function(files, opts, packageType, callback) {
    // initialise the package directory
    var interleaver = this,
        // initialise the package path
        // use pkg if the --package option was set, or 
        // just the target path if we are doing a single package --wrap
        packagePath = opts.wrap ? this.targetPath : path.join(this.targetPath, 'pkg', packageType),
        packager = require('./packagers/' + packageType),
        filelist = files.map(function(item) { return item.file; }).join(',');
        
    // ensure we have the package path available
    mkdirp(packagePath, function(err) {
        if (! err) {
            // iterate through each of the target files
            async.forEach(
                files, 
                function(fileData, itemCallback) {
                    // add the module name to the filedata
                    fileData.module = fileData.module || path.basename(fileData.file, '.js');

                    // package the file
                    packager.call(
                        interleaver,
                        path.join(packagePath, opts.output || fileData.file),
                        fileData,
                        itemCallback
                    );
                },
                function(err) {
                out('!{cyan}packaged:!{}    generated !{underline}' + packageType + '!{} packages for files: ' + filelist);
                callback(err);
            });
        }
        else {
            callback(err);
        }
    });
};

Interleaver.prototype._indent = function(content) {
    return content.split('\n').map(function(line) {
        return '  ' + line;
    }).join('\n');
};

/*
### done
*/
Interleaver.prototype.done = function() {
    this.processing = false;
    this.emit('done');
}; // done

Interleaver.prototype.exportFiles = function(files, opts) {
    var interleaver = this;
    
    // iterate through the files and determine external module requirements
    files.forEach(function(file, index) {
        // extend the file with the findme data
        _.extend(file, findme(file.content));
    });
    
    // if we are in packaging mode (amd, cjs, oldschool, etc) then 
    // run the packagers
    if (this.targetPackages.length > 0) {
        async.forEach(
            this.targetPackages,
            this._createPackages.bind(this, files, opts),
            function(err) {
                interleaver.done(err);
            }
        );
    }
    else {
        // after combining the files in the required way
        // write the files to the file system
        this.write(files, function(err, outputFiles) {
            if (! err) {
                // run the postprocessors
                postprocessors.run(interleaver, outputFiles, interleaver.after, function() {
                    interleaver.done();
                });
            }
            else {
                interleaver.done(err);
            }
        });
    }
};

Interleaver.prototype.findPackageData = function(callback) {
    var packageFile = path.resolve(this.basedir, 'package.json'),
        interleaver = this;
    
    fs.readFile(packageFile, 'utf8', function(err, data) {
        if (! err) {
            data = JSON.parse(data);
            
            // iterate through the data and update the interleaver data if not defined
            for (var key in data) {
                if (typeof interleaver.data[key] == 'undefined') {
                    interleaver.data[key] = data[key];
                }
            }
        }
        
        // trigger the callback
        callback();
    });
};

Interleaver.prototype.write = function(files, callback) {
    var interleaver = this,
        outputPath = this.targetPath,
        outputFiles = [],
        opts = this.opts;

    async.forEach(
        files,
        function(fileData, itemCallback) {
            var targetFile = path.join(outputPath, path.basename(interleaver.targetFile || fileData.file));

            out('!{cyan}write:!{}       ' + targetFile);
            mkdirp(path.dirname(targetFile), 493 /* 755 */, function() {
                // create the file stream
                var outputStream = fs.createWriteStream(targetFile),
                    targetStream = outputStream;

                /*
                REMOVED PENDING SUITABLE TESTS
                if (opts.bake) {
                    var BakeStream = require('bake-js').Stream,
                        baker = new BakeStream(opts.bake);
                        
                    // remap the target stream to the baker
                    targetStream = baker;

                    // set the basepath for bake resolution
                    baker.basePath = path.basename(targetFile);

                    // pipe from the backer to the output stream
                    baker.pipe(outputStream);
                }
                */

                outputStream.on('error', function(err) {
                    out('!{red}Error writing: ' + targetFile);
                    itemCallback(err);
                });

                outputStream.on('close', function() {
                    outputFiles.push(targetFile);
                    itemCallback();
                });
                
                // write the content to the target stream
                targetStream.write(fileData.content, 'utf8');
                targetStream.end();
            });
        },

        function(err) {
            callback(err, outputFiles);
        }
    );
}; // write

exports = module.exports = function(targetFiles, opts) {
    var interleaver;
    
    // initialise options
    opts = opts || {};
    
    // if after has been passed in as a string, then split on the comma
    if (typeof opts.after == 'string') {
        opts.after = opts.after.split(/(\,|\+)/);
    }

    // be tolerant of someone providing a string rather than an array
    if (typeof targetFiles == 'string') {
        targetFiles = [targetFiles];
    } // if

    // if we don't have the input file specified, then show the help
    if (targetFiles.length === 0) {
        return 'No target files specified';
    } // if
    
    // ensure the conversion options are defined
    opts.conversions = opts.conversions || {};
    
    // create the interleaver
    interleaver = new Interleaver(opts);
    
    // load the local package data
    interleaver.findPackageData(function() {
        _expandPaths(targetFiles, function(err, files) {
            // if we are watching, then create a watcher
            if (opts.watch) {
                require('./watcher')(interleaver, files, opts).on('change', function(file) {
                    _compile(interleaver, [file], opts);
                });
            }
            // otherwise, immediately compile
            else {
                _compile(interleaver, files, opts);
            }
        });
    });
    

    return undefined;
};

exports.compile = _compile;
