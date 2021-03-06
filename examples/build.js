var interleave = require('../lib/interleave'),
    fs = require('fs'),
    path = require('path');
    
fs.readFile(path.resolve(__dirname, 'build.json'), function(err, data) {
    var config = JSON.parse(data);
    
    fs.readdir(path.resolve(__dirname, 'testfiles'), function(err, files) {
        var targetFiles = files.map(function(file) { return 'testfiles/' + file; });
        
        interleave(targetFiles, {
            after: ['uglify'],
            config: config
        });
    });
});