/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
 
import {spawn, ChildProcess} from 'child_process';
import * as Url from 'url';
import * as ngrok from 'ngrok';

import {ChromeDebugAdapter, utils, logger} from 'vscode-chrome-debug-core';
import * as iosUtils from './utilities';
import {IProxySettings} from './iosDebugAdapterInterfaces';

export class IOSDebugAdapter extends ChromeDebugAdapter {
    private _proxyProc: ChildProcess;
    private _hasLocalTunnel: boolean = false;

    constructor(chromeConnection) {
        super(chromeConnection)
    }
        
    public launch(args: any): Promise<void> {
        if (args.port == null) {
            return utils.errP('The "port" field is required in the launch config.');
        }
        
        super.setupLogging(args);
        
        // Process the launch arguments
        const settings = this._getProxySettings(args);
        if (typeof settings == "string") {
            return utils.errP('Passed settings object is a string');
        }

        let tunnelPort = args.tunnelPort || 0;
        let launchPromise: Promise<string> = null;
        
        if (tunnelPort) {
            launchPromise = new Promise((resolve, reject) => {
                logger.log('Launching ngrok against port ' + tunnelPort);
                ngrok.connect(tunnelPort, (err: Error, url: string) => {
                    // Navigate the to the given tunneled url
                    if (err) {
                        logger.error('Failed to launch ngrok.');
                        return utils.errP(err);
                    }

                    logger.log('Success.' + tunnelPort);
                    this._hasLocalTunnel = true;

                    // Set the store member and listen for any errors
                    ngrok.once('error', (err) => {
                        logger.log('Tunneling proxy error: ' + err);
                        this.terminateSession();
                    });
                    
                    // Navigate the attached instance to the tunneled url
                    let pathname = "";
                    if (args.url) {
                        let url = Url.parse(args.url);
                        pathname = url.pathname;
                    }
                    
                    let navigateTo = Url.resolve(url, pathname);
                    resolve(navigateTo);
                });
            });
        } else {
            launchPromise = Promise.resolve(args.url);
        }
                    
        return this._spawnProxy(<IProxySettings>settings).then(() => {
            return launchPromise;          
        }).then(url => {
            logger.log('Navigating to ' + url);
            (<any>this)._chromeConnection.sendMessage("Page.navigate", {url: url});  
        });
    }
    
    public attach(args: any): Promise<void> {
        if (args.port == null) {
            return utils.errP('The "port" field is required in the attach config.');
        }

        super.setupLogging(args);
        
        // Process the attach arguments
        const settings = this._getProxySettings(args);
        if (typeof settings == "string") {
            return utils.errP('Passed settings object is a string');
        }
        
        return this._spawnProxy(<IProxySettings>settings);
    }
    
    public clearEverything(): void {
        if (this._hasLocalTunnel) {
            ngrok.kill();
            this._hasLocalTunnel = false;
        }
                
        if (this._proxyProc) {  
            this._proxyProc.kill('SIGINT');  
            this._proxyProc = null;  
        }
          
        super.clearEverything();
    }
    
    private _getProxySettings(args: any): IProxySettings | string {
        var settings: IProxySettings = null;
        var errorMessage: string = null;
        
        // Check that the proxy exists
        const proxyPath = args.proxyExecutable || iosUtils.getProxyPath();
        if (!proxyPath) {
            if (utils.getPlatform() != utils.Platform.Windows) {
                errorMessage = `No iOS proxy was found. Install an iOS proxy (https://github.com/google/ios-webkit-debug-proxy) and specify a valid 'proxyExecutable' path`;
            } else {
                errorMessage = `No iOS proxy was found. Run 'npm install -g vs-libimobile' and specify a valid 'proxyExecutable' path`;
            }
        } else {
            // Grab the specified device name, or default to * (which means first)
            const optionalDeviceName = args.deviceName || "*";

            // Start with remote debugging enabled
            const proxyPort = args.port || 9222;
            const proxyArgs = [];

            // Use default parameters for the ios_webkit_debug_proxy executable
            if (!args.proxyExecutable) {
                proxyArgs.push('--no-frontend');

                // Set the ports available for devices
                proxyArgs.push('--config=null:' + proxyPort + ',:' + (proxyPort + 1) + '-' + (proxyPort + 101));
            }

            if (args.proxyArgs) {
                // Add additional parameters
                proxyArgs.push(...args.proxyArgs);
            }
            
            settings = {
                proxyPath: proxyPath,
                optionalDeviceName: optionalDeviceName,
                proxyPort: proxyPort,
                proxyArgs: proxyArgs,
                originalArgs: args
            };
        }
        
        return errorMessage || settings;
    }
    
    private _spawnProxy(settings: IProxySettings): Promise<void> {
        // Spawn the proxy with the specified settings
        logger.log(`spawn('${settings.proxyPath}', ${JSON.stringify(settings.proxyArgs) })`);
        this._proxyProc = spawn(settings.proxyPath, settings.proxyArgs, {
            detached: true,
            stdio: ['ignore']
        });
        (<any>this._proxyProc).unref();
        this._proxyProc.on('error', (err) => {
            logger.log('device proxy error: ' + err);
            logger.log('Do you have the iTunes drivers installed?');
            this.terminateSession();
        });
        
        // Now attach to the device
        return this._attachToDevice(settings.proxyPort, settings.optionalDeviceName).then((devicePort: number) => {
            let attachArgs = settings.originalArgs;
            attachArgs["port"] = devicePort;
            attachArgs["cwd"] = "";
            return super.attach(attachArgs);
        });
    }
    
    private _attachToDevice(proxyPort: number, deviceName: string): Promise<number> {
        // Attach to a device over the proxy
        return utils.getURL(`http://localhost:${proxyPort}/json`).then(jsonResponse => {
            let devicePort = proxyPort;
            
            try {
                const responseArray = JSON.parse(jsonResponse);
                if (Array.isArray(responseArray)) {
                    let devices = responseArray.filter(deviceInfo => deviceInfo && deviceInfo.url && deviceInfo.deviceName);

                    // If a device name was specified find the matching one
                    if (deviceName !== "*") {
                        const matchingDevices = devices.filter(deviceInfo => deviceInfo.deviceName && deviceInfo.deviceName.toLowerCase() === deviceName.toLowerCase());
                        if (!matchingDevices.length) {
                            logger.log(`Warning: Can't find a device with deviceName: ${deviceName}. Available devices: ${JSON.stringify(devices.map(d => d.deviceName))}`);
                        } else {
                            devices = matchingDevices;
                        }
                    }

                    if (devices.length) {
                        if (devices.length > 1 && deviceName !== "*") {
                            logger.log(`Warning: Found more than one valid target device. Attaching to the first one. Available devices: ${JSON.stringify(devices.map(d => d.deviceName))}`);
                        }

                        // Get the port for the actual device endpoint
                        const deviceUrl: string = devices[0].url;
                        if (deviceUrl) {
                            const portIndex = deviceUrl.indexOf(':');
                            if (portIndex > -1) {
                                devicePort = parseInt(deviceUrl.substr(portIndex + 1), 10);
                            }
                        }
                    }
                }
            }
            catch (e) {
                // JSON.parse can throw
            }
            
            return devicePort;
        },
        e => {
            return utils.errP('Cannot connect to the proxy: ' + e.message);
        });
    }
}
