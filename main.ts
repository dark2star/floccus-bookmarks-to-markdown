import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, RequestUrlParam, RequestUrlResponse, requestUrl } from 'obsidian';
import { join, parse } from 'path';
import { promises as fsPromises } from 'fs';
import { parseStringPromise } from 'xml2js';
import { error } from 'console';
import * as fs from 'fs';
import * as path from 'path';
import { finished } from 'stream';

interface fbmPluginSettings {
    xbelFolderPath: string;
    xbelFileName: string;
    mdFolderPath: string;
    mdFileName: string;
    backupFolderPath: string;
    keepCount: number;
    automaticUpdate: boolean;
    updateInterval: number;
    html2mdApi:string;
}

const DEFAULT_SETTINGS: fbmPluginSettings = {
    xbelFolderPath: '',
    xbelFileName: 'bookmarks.xbel',
    mdFolderPath: '',
    mdFileName: 'bookmarks.md',
    backupFolderPath: '',
    keepCount: 5,
    automaticUpdate: false,
    updateInterval: 1920,
    html2mdApi: 'https://r.jina.ai/'
}

const jsonName = '.bks.json';

export default class fbmPlugin extends Plugin {
    settings: fbmPluginSettings;
    nameSiteMapping: Map<any, any>;
    fileNames: string[];

    async onload() {
        await this.loadSettings();
        
        // This creates an icon in the left ribbon.
        const bookmarkIconEl = this.addRibbonIcon('book-marked', 'Sync Bookmarks To Note', (evt: MouseEvent) => {
            // Called when the user clicks the icon.
            this.processXBELFileData();
            new Notice('Bookmarks Markdown Updated!');
        });

        // Perform additional things with the ribbon
        bookmarkIconEl.addClass('sync-bookmarks-to-note-icon');

        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new FBMSettingTab(this.app, this));

        // Call the processXBELFileData function based on the automatic update setting
        if (this.settings.automaticUpdate) {
            const updateInterval = this.settings.updateInterval * 1000 * 60; // Convert minutes to milliseconds
            this.registerInterval(window.setInterval(() => this.processXBELFileData(), updateInterval));
        }

        // Call the processXBELFileData function
        this.processXBELFileData();
    }

    onunload() {}

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.processXBELFileData();
    }

    async processXBELFileData() {
        const {
            xbelFolderPath,
            xbelFileName,
            mdFolderPath,
            mdFileName,
            backupFolderPath,
            keepCount,
        } = this.settings;

        // Construct the full paths
        const xbelFilePath: string = join(xbelFolderPath, xbelFileName);
        //const xbelFilePath: string = path.join(xbelFolderPath, xbelFileName);
        const mdFilePath = `${mdFolderPath}/${mdFileName}`;
        const mdFile = this.app.vault.getAbstractFileByPath(mdFilePath) as TFile;

        // Create the output folder if it doesn't exist
        /*const mdFolder = this.app.vault.getAbstractFileByPath(mdFolderPath) as TFolder;
        if (!mdFolder) {
            await this.app.vault.createFolder(mdFolderPath);
        }*/
        if (!fs.existsSync(mdFolderPath)) {
            fs.mkdirSync(mdFolderPath, { recursive: true });
        }
        

        // Check if the output file already exists and backup if necessary
        if (mdFile) {
            await this.backupExistingFile(mdFile, backupFolderPath);
        }

        // Delete old backups, keeping only the specified number of most recent ones
        this.deleteOldBackups(backupFolderPath, keepCount);

        try {
            // Read the XBEL file
            let xbelData = '';
            if(xbelFolderPath?.startsWith('http://') || xbelFolderPath?.startsWith('https://')) {
                const { path, username, password } = this.parseUrl(`${xbelFolderPath}/${xbelFileName}`);
                const res = await this.getWebDavFile(path, username, password);
                if (res !== null) {
                    xbelData = res.toString();
                }
            } else {
                xbelData = await fsPromises.readFile(xbelFilePath, 'utf8');
            }
        
            // Parse the XBEL file
            const result = await parseStringPromise(xbelData);
        
            this.fileNames = this.getExistBookMark(mdFolderPath, jsonName);
            this.nameSiteMapping = new Map();

            // Generate the folder structure
            const mdData = this.writeFolderStructure(result.xbel);
        
            // Create the Markdown file with the generated data
            // await this.app.vault.create(mdFilePath, mdData);
            await fs.writeFile(mdFilePath, mdData, error =>{});

            if(this.nameSiteMapping.size > 0) {
                console.log(this.nameSiteMapping);
                this.processBkLinks(this.nameSiteMapping, 900).then(() => {
                    // 保存已经抓取的书签到json文件 
                    this.fileNames.push(...Array.from(this.nameSiteMapping.values()));
                    this.saveContent2json(`${mdFolderPath}/${jsonName}`, Array.from(new Set(this.fileNames)));
                    console.log('work finished!');
                    new Notice('Sync Bookmarks To Note finished!');
                }).catch(error => {
                    console.error('An error occurred during fetching:', error);
                });
            }
        } catch (error) {
            console.error('An error occurred:', error);
        }
    }
    
    async backupExistingFile(file: TFile, backupFolderPath: string): Promise<void> {
        // Generate a date-time suffix in the format 'yyyymmddHHMMSS' using the current timezone
        const now = new Date();
        const timeZoneOffset = now.getTimezoneOffset() * 60000; // Convert minutes to milliseconds
        const localTime = new Date(now.getTime() - timeZoneOffset);
        const dateSuffix: string = localTime.toISOString().slice(0, 19).replace(/[-T:]/g, '');

        // Create the backup folder if it doesn't exist
        const backupFolder = this.app.vault.getAbstractFileByPath(backupFolderPath) as TFolder;
        if (!backupFolder) {
            await this.app.vault.createFolder(backupFolderPath);
        }

        // Create a new file name with the date-time suffix
        const fileName = file.basename;
        const fileExtension = file.extension;
        const backupFileName = `${parse(fileName).name}-${dateSuffix}.${fileExtension}`;
        const backupFilePath = `${backupFolderPath}/${backupFileName}`;
        
        // Copy the existing file to the backup file
        await this.app.vault.rename(file, backupFilePath);
        
    }

    deleteOldBackups(backupFolderPath: string, keepCount: number): void {
        // Get all files in the backup folder
        const backupFolder = this.app.vault.getAbstractFileByPath(backupFolderPath) as TFolder;
        if (!backupFolder) {
            return;
        }

        const backupFiles = backupFolder.children as TFile[];

        // Sort the files by modification time in ascending order
        backupFiles.sort((a, b) => {
            const statA = a.stat;
            const statB = b.stat;
            return statA.mtime - statB.mtime;
        });

        // Delete files exceeding the keep count
        const filesToDelete = backupFiles.length - keepCount+1;
        if (filesToDelete > 0) {
            const filesToDeleteList = backupFiles.slice(0, filesToDelete);
            filesToDeleteList.forEach(async (file) => {
                await this.app.vault.trash(file, false);
            });
        }
    }

    writeFolderStructure(element: any, level = 0): string {
        const {
            html2mdApi,
            mdFolderPath
        } = this.settings;

        let data = '';
        const fileNameLength = 40;
        // Process child elements (folders and bookmarks)
        if (typeof element === 'object') {
            if (element.hasOwnProperty('folder') || element.hasOwnProperty('bookmark')) {
                const folderTitle: string = element.title ? element.title[0] : 'Bookmarks';
    
                if (level !== 0) {
                    data += '\n';
                }
    
                data += '#'.repeat(level+1) + ' ' + folderTitle + '\n';
            }
            
            //const fileNames = this.getExistBookMark(mdFolderPath, jsonName);
            //let nameSiteMapping = new Map();
            if (Array.isArray(element.bookmark)) {
                // Process bookmarks
                element.bookmark.forEach((bookmark: any) => {
                    const link: string = bookmark.$.href;
                    const title: string = bookmark.title[0];
                    const linkTitle = `[${title}](${link})`;
                    data += linkTitle + '\n';
                    // Get the content of the link in the bookmark and save it
                    if(html2mdApi?.length > 0) {
                        const fileName = `${title.substring(0, fileNameLength).trim().replace(/[\/:*?"<>|]/g, '')}.md`;
                        console.log(`${mdFolderPath}/${fileName} check......`);
                        if(!this.fileNames.includes(`${mdFolderPath}/${fileName}`)) {
                            console.log(`${mdFolderPath}/${fileName} not exist.`);
                            this.nameSiteMapping.set(`${html2mdApi}${link}`, `${mdFolderPath}/${fileName}`);
                        }
                    }
                });
            }
    
            if (Array.isArray(element.folder)) {
                // Recursively process subfolders
                element.folder.forEach((subfolder: any) => {
                    data += this.writeFolderStructure(subfolder, level + 1);
                });
            }

            /*
            if(nameSiteMapping.size > 0) {
                console.log(nameSiteMapping);
                this.processBkLinks(nameSiteMapping, 1500).then(() => {
                    // 保存已经抓取的书签到json文件 
                    fileNames.push(...Array.from(nameSiteMapping.values()));
                    this.saveContent2json(`${mdFolderPath}/${jsonName}`, Array.from(new Set(fileNames)));
                }).catch(error => {
                    console.error('An error occurred during fetching:', error);
                });
            }*/
        }
    
        return data;
    }

    // 获取已经保存的书签列表
    getExistBookMark(dirPath: string, jsonName: string | null): string[] {
        const files: string[] = [];
        const items = fs.readdirSync(dirPath);

        for (const item of items) {
            const fullPath = path.join(dirPath, item);
            const stats = fs.lstatSync(fullPath);

            if (stats.isDirectory()) {
                // 递归遍历子目录
                const nestedFiles = this.getExistBookMark(fullPath, null);
                files.push(...nestedFiles);
            } else {
                // 收集文件名
                files.push(`${dirPath}/${item}`);
            }
        }
        // 加入已经写入的url
        if(jsonName && jsonName?.length > 0) {
            try {
                const data = fs.readFileSync(`${dirPath}/${jsonName}`, 'utf8');
                files.push(...JSON.parse(data));
              } catch (err) {
                console.error('读取文件时发生错误:', err);
              }
        }
        
        return Array.from(new Set(files));
    }

    saveContent2json(filePath: string, content: any) {
        // 将数组转换为 JSON 字符串
        const dataToWrite = JSON.stringify(content);
        fs.writeFile(filePath, dataToWrite, (err) => {
          if (err) {
            console.error('Error writing file:', err);
            return;
          }
          console.log('Array written to file successfully!');
        });
    }

    async processBkLinks(nameSiteMapping: Map<string, string>, interval: number = 2000): Promise<void> {
        for (let [url, mdPath] of nameSiteMapping.entries()) {
            console.log(url, mdPath);
            try {
                const options: RequestUrlParam = {
                    url: url,
                    method: 'GET'
                };
                const response = await requestUrl(options);
                // 在这里处理你的数据
                const fileData = await response.text;
                await fs.promises.writeFile(mdPath, fileData); // 使用fs.promises进行异步写入
            } catch (error) {
                console.error(`Fetch failed for ${url}:`, error);
                /*if(error.toString().trim().includes('status 429')) {
                    await new Promise(resolve => setTimeout(resolve, interval));
                }*/
            }
            // 等待指定的间隔
            await new Promise(resolve => setTimeout(resolve, interval));
        }
    }

    async getWebDavFile(url: string, username: string | null, password: string | null): Promise<string> {
        let auth = '';
        if(username && password) {
          auth = `Basic ${btoa(`${username}:${password}`)}`
        }
        console.log(`url=${url},username=${username},pass=${password},auth=${auth}`);
        const options: RequestUrlParam = {
            url: url,
            method: 'GET',
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                Authorization: auth
            }
        }     
        try {
            const response = await requestUrl(options);
            return await response.text;
        } catch(e) {
            console.log(JSON.stringify(e));
        }
        return '';
      }
    
    async reSync() {
        const {
            mdFolderPath
        } = this.settings;
        try {
            await fs.promises.unlink(`${mdFolderPath}/${jsonName}`);
            console.log(`File ${mdFolderPath}/${jsonName} has been deleted.`);
        } catch (error) {
            console.error(`Error deleting file ${mdFolderPath}/${jsonName}:`, error);
            return;
        }
        this.processXBELFileData();
    }

    parseUrl(url: string): { path: string, username: string | null, password: string | null } {
        // 使用正则表达式匹配并捕获协议、用户名、密码和URL主体部分
        const regex = /^(?<protocol>[^:]+):\/\/(?<username>[^@]+)@(?<password>[^:]+):(?<url>.+)$/;
        const match = url.match(regex);
        if (match && match.groups) {
            // 从匹配结果中提取协议、用户名、密码和URL主体
            const { protocol, username, password, url } = match.groups;
            const path = `${protocol}://${url}`;
            return {
                path,
                username,
                password
            };
        } 
        return {
            path: url,
            username: null,
            password: null
        };
    }
    
}

class FBMSettingTab extends PluginSettingTab {
    plugin: fbmPlugin;

    constructor(app: App, plugin: fbmPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl)
        .setName('Xbel absolute folder path')
        .setDesc('The absolute folder path of the xbel file. Support webdav, format:https://username@password:url')
        .addText((text) =>
            text
            .setValue(this.plugin.settings.xbelFolderPath)
            .onChange(async (value) => {
                this.plugin.settings.xbelFolderPath = value;
                await this.plugin.saveSettings();
            })
        );

        new Setting(containerEl)
        .setName('Xbel filename')
        .setDesc('The filename of the xbel file.')
        .addText((text) =>
            text
            .setValue(this.plugin.settings.xbelFileName)
            .onChange(async (value) => {
                this.plugin.settings.xbelFileName = value;
                await this.plugin.saveSettings();
            })
        );

        new Setting(containerEl)
        .setName('Markdown vault folder path')
        .setDesc('The vault folder for the generated markdown file.')
        .addText((text) =>
            text
            .setValue(this.plugin.settings.mdFolderPath)
            .onChange(async (value) => {
                this.plugin.settings.mdFolderPath = value;
                await this.plugin.saveSettings();
            })
        );

        new Setting(containerEl)
        .setName('Markdown file')
        .setDesc('The filename for the generated markdown file.')
        .addText((text) =>
            text
            .setValue(this.plugin.settings.mdFileName)
            .onChange(async (value) => {
                this.plugin.settings.mdFileName = value;
                await this.plugin.saveSettings();
            })
        );

        new Setting(containerEl)
        .setName('Backup folder path')
        .setDesc('The vault folder for the backup files.')
        .addText((text) =>
            text
            .setValue(this.plugin.settings.backupFolderPath)
            .onChange(async (value) => {
                this.plugin.settings.backupFolderPath = value;
                await this.plugin.saveSettings();
            })
        );

        new Setting(containerEl)
        .setName('Number of backups to keep')
        .setDesc('The number of backup files to keep.')
        .addText((text) =>
            text
            .setValue(String(this.plugin.settings.keepCount))
            .onChange(async (value) => {
                const keepCount = parseInt(value, 10);
                if (!isNaN(keepCount)) {
                    this.plugin.settings.keepCount = keepCount;
                    await this.plugin.saveSettings();
                }
            })
        );

        new Setting(containerEl)
        .setName('Automatic update bookmarks')
        .setDesc('Enable automatic updating of bookmarks.')
        .addToggle((toggle) =>
            toggle
            .setValue(this.plugin.settings.automaticUpdate)
            .onChange(async (value) => {
                this.plugin.settings.automaticUpdate = value;
                await this.plugin.saveSettings();
            })
        );

        new Setting(containerEl)
        .setName('Update interval (in minutes)')
        .setDesc('Specify the interval for automatic updates. Automatic update bookmarks must be on.')
        .addText((text) =>
            text
            .setValue(String(this.plugin.settings.updateInterval))
            .onChange(async (value) => {
                const updateInterval = parseInt(value, 10);
                if (!isNaN(updateInterval)) {
                    this.plugin.settings.updateInterval = updateInterval;
                    await this.plugin.saveSettings();
                }
            })
        );

        new Setting(containerEl)
        .setName('Html to Markdown API URL')
        .setDesc('The HTML to Markdown API.')
        .addText((text) =>
            text
            .setValue(this.plugin.settings.html2mdApi)
            .onChange(async (value) => {
                this.plugin.settings.html2mdApi = value;
                await this.plugin.saveSettings();
            })
        );

        new Setting(containerEl)
        .setName("Resync bookmarks")
        .setDesc(
          `Solve the problem that bookmark synchronization is not synchronized due to an error.`
        )
        .addButton((cb) => {
          cb.setWarning()
            .setButtonText("Resync bookmarks")
            .onClick(() => {
                new Notice('Task start,Please be patient.');
                this.plugin.reSync();
            });
        });

    }
}