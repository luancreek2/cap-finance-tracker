/* Reproducible static-browser dependency, not an application build step. */
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),pkg=require('animejs/package.json');
const expected=require('../package.json').dependencies.animejs;
if(pkg.version!==expected)throw Error('Anime.js version does not match the exact project pin');
const source=path.dirname(require.resolve('animejs/package.json'));
const dest=path.join(root,'assets/vendor/animejs');
fs.mkdirSync(dest,{recursive:true});
fs.copyFileSync(path.join(source,'dist/bundles/anime.esm.min.js'),path.join(dest,'anime.esm.min.js'));
fs.copyFileSync(path.join(source,'LICENSE.md'),path.join(dest,'LICENSE.md'));
console.log('Vendored Anime.js '+pkg.version+' (one browser ES module)');
