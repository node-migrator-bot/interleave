var debug = require('debug')('interleave'),
    async = require('async'),
    fs = require('fs'),
    path = require('path'),
    files = fs.readdirSync(__dirname),
    out = require('out'),
    postprocessors = {};
    
// ## exports
    
exports.run = function(interleaver, files, selected, callback) {
    // for each of the selected post processors, parse each of the files
    async.forEach(selected, function(item, itemCallback) {
        var processor = postprocessors[item],
            supportedFiles = [];
        
        // if we have the processor then run it
        if (! processor || (! processor.process)) {
            itemCallback('Unable to find postprocessor: ' + item);
        }
        else {
            // get the items that match the supported extensions
            supportedFiles = files.filter(function(file) {
                // include if the processor has not specifically defined supported extensions
                // or the extension of the file is in the array of supported extensions
                return (! processor.extensions) || processor.extensions.indexOf(path.extname(file)) >= 0;
            });
            
            // process the supported files
            processor.process(interleaver, supportedFiles, function(err) {
                if (err) {
                    out('!{bold}warn:!{red}        error running ' + item + ' postprocessor - ' + err);
                }
                
                // don't pass the error on, as this will prevent other postprocessors running
                // and postprocessors aren't usually dependant on one another.
                itemCallback();
            });
        }
    }, callback);
};

// ## Module Initialization

// look for javascript files in this folder
files.forEach(function(file) {
    var moduleName = path.basename(file, '.js'),
        module;
    
    // if we are dealing with a javascript file, and it's not this file
    // then it's a possible preprocessor
    if (path.extname(file) === '.js' && moduleName !== 'index') {
        // now include the preprocessor and assign as an export
        postprocessors[moduleName] = require('./' + moduleName);
    }
});
