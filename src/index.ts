import {
  injectAssetManifest,
  interpolateHTMLAssets,
  replaceCSSUrls,
  replacePublicPath,
} from './utils';
import { Compiler } from 'webpack';
import md5 from 'md5';
import path from 'path';
import fs from 'fs';
/**
 * 1. webworker: not supported
 * 2. module federation: not tested
 */
class Webpack5CDNPlugin {
  private pluginName = 'Webpack5-CDN-Plugin';

  constructor(
    public options: {
      keepLocalFiles?: boolean;
      manifestFilename?: boolean | string;
      uploadContent: (input: {
        file: string;
        content: string | Buffer;
        extname: string;
      }) => Promise<string | null | undefined>;
    }
  ) {}

  apply(compiler: Compiler) {
    // only work in production mode
    if ((process.env.NODE_ENV || compiler.options.mode) !== 'production') {
      return;
    }

    const {
      pluginName,
      options: { manifestFilename, uploadContent, keepLocalFiles = true },
    } = this;
    const outputPath: string = compiler.options.output.path as string;
    const cacheLocalPath = path.join(outputPath, '.webpack-cdn-cache');

    // const fs = compiler.outputFileSystem;
    const {
      Compilation,
      sources: { RawSource },
    } = compiler.webpack;

    const assetMap = new Map<string, string | Buffer>();
    let urlCacheMap = new Map<string, string>();

    compiler.hooks.initialize.tap(pluginName, () => {
      // read cache url from local
      if (fs.existsSync(cacheLocalPath)) {
        urlCacheMap = new Map(
          Object.entries(JSON.parse(fs.readFileSync(cacheLocalPath).toString()))
        );
      }
    });
    compiler.hooks.thisCompilation.tap(pluginName, (compilation) => {
      const { publicPath } = compilation.outputOptions;

      if (publicPath) {
        throw `Error: You should set publicPath to ""`;
      }
    });

    compiler.hooks.compilation.tap(pluginName, (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: pluginName,
          stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
        },
        (assets) => {
          // 往js里面插东西，处理 `__webpack_require__.p`
          // 这个时候还没开始压缩
          Object.entries(assets).forEach(([filename, source]) => {
            if (filename.endsWith('.js')) {
              compilation.updateAsset(
                filename,
                new RawSource(replacePublicPath(source.source().toString()))
              );
            }
          });
        }
      );
    });

    compiler.hooks.emit.tap(pluginName, (compilation) => {
      const assets = compilation.getAssets();

      assets.forEach((asset) => {
        const source = asset.source.source();
        const isText = /\.(js|css|html)$/.test(asset.name);

        assetMap.set(asset.name, isText ? source.toString() : source);
      });
    });

    compiler.hooks.afterEmit.tapPromise(pluginName, async (compilation) => {
      const stats = compilation.getStats().toJson();

      const urlMap = new Map<string, string>();
      const getManifestJSON = (format?: boolean) => {
        return JSON.stringify(
          Object.fromEntries(
            // as stable as possible
            [...urlMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
          ),
          null,
          format ? 2 : undefined
        );
      };

      const unlink = (name: string) =>
        new Promise((resolve, reject) => {
          fs.unlink?.(stats.outputPath + '/' + name, (err) => {
            if (err) {
              reject(err);
            }
            resolve(null);
          });
        });
      const overwrite = (name: string, content: string | Buffer) =>
        new Promise((resolve, reject) => {
          fs.writeFile(stats.outputPath + '/' + name, content, (err) => {
            if (err) {
              reject(err);
            }
            resolve(null);
          });
        });

      const uploadFile = async (
        name: string,
        content: string | Buffer,
        shouldOverwrite?: boolean
      ) => {
        if (shouldOverwrite) {
          await overwrite(name, content);
        }
        const cacheUrl = urlCacheMap.get(md5(content));
        const url =
          cacheUrl ||
          (await uploadContent({
            file: name,
            content,
            extname: path.extname(name),
          }));
        if (url && typeof url === 'string') {
          urlMap.set(name, url);
          urlCacheMap.set(md5(content), url);
          if (!keepLocalFiles) {
            await unlink(name);
          }
        }
      };

      const [epNames, styleNames, htmlNames, resourceNames] = [
        new Set<string>(),
        new Set<string>(),
        new Set<string>(),
        new Set<string>(),
      ];
      {
        Object.keys(stats.entrypoints || {}).forEach((key) => {
          stats.entrypoints?.[key].assets?.forEach(({ name }) =>
            epNames.add(name)
          );
        });
        stats.assets
          ?.filter(({ name }) => !name.endsWith('.map'))
          ?.forEach(({ name }) => {
            if (epNames.has(name)) return;
            else if (name.endsWith('.css')) styleNames.add(name);
            else if (name.endsWith('.html')) htmlNames.add(name);
            else resourceNames.add(name);
          });
      }

      await Promise.all(
        Array.from(resourceNames).map((name) =>
          uploadFile(name, assetMap.get(name)!)
        )
      );

      await Promise.all(
        Array.from(styleNames).map((name) =>
          uploadFile(
            name,
            replaceCSSUrls(name, assetMap.get(name) as string, urlMap),
            true
          )
        )
      );

      await Promise.all(
        Array.from(epNames).map((name) =>
          uploadFile(
            name,
            injectAssetManifest(
              assetMap.get(name) as string,
              getManifestJSON()
            ),
            true
          )
        )
      );

      await Promise.all(
        Array.from(htmlNames).map((name) =>
          overwrite(
            name,
            interpolateHTMLAssets(
              assetMap.get(name) as string,
              urlMap,
              getManifestJSON()
            )
          )
        )
      );

      if (manifestFilename) {
        await overwrite(
          manifestFilename === true ? 'manifest.json' : manifestFilename,
          getManifestJSON(true)
        );
      }
    });

    compiler.hooks.done.tap(pluginName, () => {
      // cache url to local
      fs.writeFileSync(
        cacheLocalPath,
        JSON.stringify(Object.fromEntries(urlCacheMap.entries()))
      );
      // clean up
      assetMap.forEach((_, key) => assetMap.delete(key));
    });
  }
}

export { Webpack5CDNPlugin };
export default Webpack5CDNPlugin;
