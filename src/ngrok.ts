// Typings for ngrok

declare module 'ngrok' {  
    
    module ngrok {
        function connect(port: number, callback: (err: Error, url: string) => void): void;
        function once(event: string, callback: (err: Error) => void): void;
        function on(event: string, callback: (err: Error) => void): void;
        function kill(): void;
    }

    export = ngrok;
}