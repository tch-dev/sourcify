import bunyan from 'bunyan';
import Web3 from 'web3';
import { StringMap, SourceMap, PathBuffer, PathContent, CheckedContract, InvalidSources, MissingSources } from '@ethereum-sourcify/core';
import AdmZip from 'adm-zip';
import fs from 'fs';
import Path from 'path';
/**
 * Regular expression matching metadata nested within another json.
 */
const NESTED_METADATA_REGEX = /"{\\"compiler\\":{\\"version\\".*?},\\"version\\":1}"/;
const HARDHAT_OUTPUT_FORMAT_REGEX = /"hh-sol-build-info-1"/;

const CONTENT_VARIATORS = [
    (content: string) => content,
    (content: string) => content.replace(/\r?\n/g, "\r\n"),
    (content: string) => content.replace(/\r\n/g, "\n")
];

const ENDING_VARIATORS = [
    (content: string) => content,
    (content: string) => content.trimEnd(),
    (content: string) => content.trimEnd() + "\n",
    (content: string) => content.trimEnd() + "\r\n",
    (content: string) => content + "\n",
    (content: string) => content + "\r\n"
];

export interface IValidationService {
    /**
     * Checks all metadata files found in the provided paths. Paths may include regular files, directoris and zip archives.
     * 
     * @param paths The array of paths to be searched and checked.
     * @param ignoring Optional array where all unreadable paths can be stored.
     * @returns An array of CheckedContract objects.
     * @throws Error if no metadata files are found.
     */
    checkPaths(paths: string[], ignoring?: string[]): CheckedContract[];

    /**
     * Checks the provided files. Works with zips.
     * Attempts to find all the resources specified in every metadata file found.
     * 
     * @param files The array or object of buffers to be checked.
     * @returns An array of CheckedContract objets.
     * @throws Error if no metadata files are found.
     */
    checkFiles(files: PathBuffer[], unused?: string[]): CheckedContract[];
    useAllSources(contract: CheckedContract, files: PathBuffer[]): CheckedContract;
}

export class ValidationService implements IValidationService {
    logger: bunyan;

    /**
     * @param logger a custom logger that logs all errors; undefined or no logger provided turns the logging off
     */
    constructor(logger?: bunyan) {
        this.logger = logger;
    }

    checkPaths(paths: string[], ignoring?: string[]): CheckedContract[] {
        const files: PathBuffer[] = [];
        paths.forEach(path => {
            if (fs.existsSync(path)) {
                this.traversePathRecursively(path, filePath => {
                    const fullPath = Path.resolve(filePath);
                    const file = {buffer: fs.readFileSync(filePath), path: fullPath};
                    files.push(file);
                });
            } else if (ignoring) {
                ignoring.push(path);
            }
        });

        return this.checkFiles(files);
    }
    
    // Pass all input source files to the CheckedContract, not just those stated in metadata.
    useAllSources(contract: CheckedContract, files: PathBuffer[]) {
        const unzippedFiles = this.traverseAndUnzipFiles(files);
        const parsedFiles = unzippedFiles.map(pathBuffer => ({ content: pathBuffer.buffer.toString(), path: pathBuffer.path }));
        const { sourceFiles } = this.splitFiles(parsedFiles);
        const stringMapSourceFiles = this.pathContentArrayToStringMap(sourceFiles)
        // Files at contract.solidity are already hash matched with the sources in metadata. Use them instead of the user input .sol files.
        Object.assign(stringMapSourceFiles, contract.solidity)
        const contractWithAllSources = new CheckedContract(contract.metadata, stringMapSourceFiles, contract.missing, contract.invalid);
        return contractWithAllSources;
    }

    checkFiles(files: PathBuffer[], unused?: string[]): CheckedContract[] {
        const unzippedFiles = this.traverseAndUnzipFiles(files);
        const parsedFiles = unzippedFiles.map(pathBuffer => ({ content: pathBuffer.buffer.toString(), path: pathBuffer.path }));
        const { metadataFiles, sourceFiles } = this.splitFiles(parsedFiles);

        const checkedContracts: CheckedContract[] = [];
        const errorMsgMaterial: string[] = [];

        const byHash = this.storeByHash(sourceFiles);
        const usedFiles: string[] = [];

        metadataFiles.forEach(metadata => {
            const { foundSources, missingSources, invalidSources, metadata2provided } = this.rearrangeSources(metadata, byHash);
            const currentUsedFiles = Object.values(metadata2provided);
            usedFiles.push(...currentUsedFiles);
            const checkedContract = new CheckedContract(metadata, foundSources, missingSources, invalidSources);
            checkedContracts.push(checkedContract);
            if (!CheckedContract.isValid(checkedContract)) {
                errorMsgMaterial.push(checkedContract.getInfo());
            }
        });

        if (errorMsgMaterial.length) {
            const msg = errorMsgMaterial.join("\n");
            if (this.logger) this.logger.error(msg);
        }

        if (unused) {
            this.extractUnused(sourceFiles, usedFiles, unused);
        }

        return checkedContracts;
    }

    /**
     * Traverses the given files, unzipping any zip archive.
     * 
     * @param files the array containing the files to be checked
     * @returns an array containing the provided files, with any zips being unzipped and returned
     */
    private traverseAndUnzipFiles(files: PathBuffer[]): PathBuffer[] {
        const inputFiles: PathBuffer[] = [];
        for (const file of files) {
            if (this.isZip(file.buffer)) {
                this.unzip(file, files);
            } else {
                inputFiles.push(file);
            }
        }

        return inputFiles;
    }

    /**
     * Checks whether the provided file is in fact zipped.
     * @param file the buffered file to be checked
     * @returns true if the file is zipped; false otherwise
     */
    private isZip(file: Buffer): boolean {
        try {
            new AdmZip(file);
            return true;
        } catch (err) { undefined }
        return false;
    }

    /**
     * Unzips the provided file buffer to the provided array.
     * 
     * @param zippedFile the buffer containin the zipped file to be unpacked
     * @param files the array to be filled with the content of the zip
     */
    private unzip(zippedFile: PathBuffer, files: PathBuffer[]): void {
        const timestamp = Date.now().toString() + "-" + Math.random().toString().slice(2);
        const tmpDir = `tmp-unzipped-${timestamp}`;

        new AdmZip(zippedFile.buffer).extractAllTo(tmpDir);

        this.traversePathRecursively(tmpDir, filePath => {
            const file = {
                buffer: fs.readFileSync(filePath),
                // remove the zip-folder name from the path  e.g. tmp-unzipped-1652274174745-9239260350002245/contracts/Token.sol --> contracts/Token.sol
                path: filePath.slice(tmpDir.length + 1)};
            files.push(file);
        });
        this.traversePathRecursively(tmpDir, fs.unlinkSync, fs.rmdirSync);
    }

    /**
     * Selects metadata files from an array of files that may include sources, etc
     * @param  {string[]} files
     * @return {string[]}         metadata
     */
    private splitFiles(files: PathContent[]): { metadataFiles: any[], sourceFiles: PathContent[] } {
        const metadataFiles = [];
        const sourceFiles: PathContent[] = [];
        const malformedMetadataFiles = [];

        for (const file of files) {
            // If hardhat output file, extract source and metadatas.
            if (file.content.match(HARDHAT_OUTPUT_FORMAT_REGEX)) {
                const {hardhatMetadataFiles, hardhatSourceFiles} = this.extractHardhatMetadataAndSources(file);
                sourceFiles.push(...hardhatSourceFiles);
                metadataFiles.push(...hardhatMetadataFiles);
                continue;
            }

            let metadata = this.extractMetadataFromString(file.content);
            if (!metadata) {
                const matchRes = file.content.match(NESTED_METADATA_REGEX);
                if (matchRes) {
                    metadata = this.extractMetadataFromString(matchRes[0]);
                }
            }

            if (metadata) {
                try {
                    this.assertObjectSize(metadata.settings.compilationTarget, 1);
                    metadataFiles.push(metadata);
                } catch (err) {
                    malformedMetadataFiles.push(file.path);
                }
            } else {
                sourceFiles.push(file);
            }
        }

        let msg = "";
        if (malformedMetadataFiles.length) {
            const responsibleFiles =
                malformedMetadataFiles.every(Boolean) ?
                malformedMetadataFiles.join(", ") : `${malformedMetadataFiles.length} metadata files`;
            msg = `Malformed settings.compilationTarget in: ${responsibleFiles}`;

        } else if (!metadataFiles.length) {
            msg = "Metadata file not found. Did you include \"metadata.json\"?";
        }

        if (msg) {
            if (this.logger) this.logger.error(msg);
            throw new Error(msg);
        }

        return { metadataFiles, sourceFiles };
    }

    /**
     * Validates metadata content keccak hashes for all files and
     * returns mapping of file contents by file name
     * @param  {any}       metadata
     * @param  {Map<string, any>}  byHash    Map from keccak to source
     * @return foundSources, missingSources, invalidSources
     */
    private rearrangeSources(metadata: any, byHash: Map<string, PathContent>) {
        const foundSources: StringMap = {};
        const missingSources: MissingSources = {};
        const invalidSources: InvalidSources = {};
        const metadata2provided: StringMap = {}; // maps fileName as in metadata to the fileName of the provided file

        for (const sourcePath in metadata.sources) {
            const sourceInfoFromMetadata = metadata.sources[sourcePath];
            let file: PathContent = { content: undefined };
            file.content = sourceInfoFromMetadata.content;
            const expectedHash: string = sourceInfoFromMetadata.keccak256;
            if (file.content) { // Source content already in metadata
                const contentHash = Web3.utils.keccak256(file.content)
                if (contentHash != expectedHash) {
                    invalidSources[sourcePath] = {
                        expectedHash: expectedHash,
                        calculatedHash: contentHash,
                        msg: `The keccak256 given in the metadata and the calculated keccak256 of the source content in metadata don't match`
                    }
                    continue;
                }
            } else { // Get source from input files by hash
                const pathContent = byHash.get(expectedHash);
                if (pathContent) {
                    file = pathContent;
                    metadata2provided[sourcePath] = pathContent.path;
                } // else: no file has the hash that was searched for
            }

            if (file && file.content) {
                foundSources[sourcePath] = file.content;
            } else {
                missingSources[sourcePath] = { keccak256: expectedHash, urls: sourceInfoFromMetadata.urls };
            }
        }

        return { foundSources, missingSources, invalidSources, metadata2provided };
    }

    /**
     * Generates a map of files indexed by the keccak hash of their content.
     * 
     * @param  {string[]}  files Array containing sources.
     * @returns Map object that maps hash to PathContent.
     */
    private storeByHash(files: PathContent[]): Map<string, PathContent> {
        const byHash: Map<string, PathContent> = new Map();

        for (const pathContent of files) {
            for (const variation of this.generateVariations(pathContent)) {
                const calculatedHash = Web3.utils.keccak256(variation.content);
                byHash.set(calculatedHash, variation);
            }
        }

        return byHash;
    }

    private generateVariations(pathContent: PathContent): PathContent[] {
        const variations: string[] = [];
        const original = pathContent.content;
        for (const contentVariator of CONTENT_VARIATORS) {
            const variatedContent = contentVariator(original);
            for (const endingVariator of ENDING_VARIATORS) {
                const variation = endingVariator(variatedContent);
                variations.push(variation);
            }
        }

        return variations.map(content => {
            return { content, path: pathContent.path }
        });
    }

    private extractUnused(inputFiles: PathContent[], usedFiles: string[], unused: string[]): void {
        const usedFilesSet = new Set(usedFiles);
        const tmpUnused = inputFiles.map(pc => pc.path).filter(file => !usedFilesSet.has(file));
        unused.push(...tmpUnused);
    }

    private extractMetadataFromString(file: string): any {
        try {
            let obj = JSON.parse(file);
            if (this.isMetadata(obj)) {
                return obj;
            }

            // if the input string originates from a file where it was double encoded (e.g. truffle)
            obj = JSON.parse(obj);
            if (this.isMetadata(obj)) {
                return obj;
            }
        } catch (err) { undefined } // Don't throw here as other files can be metadata files.

        return null;
    }

    /**
     * A method that checks if the provided object was generated as a metadata file of a Solidity contract.
     * Current implementation is rather simplistic and may require further engineering.
     * 
     * @param metadata the JSON to be checked
     * @returns true if the provided object is a Solidity metadata file; false otherwise
     */
    private isMetadata(obj: any): boolean {
        return  (obj.language === "Solidity") &&
                !!obj.compiler;
    }

    /**
     * Applies the provided worker function to the provided path recursively.
     * 
     * @param path the path to be traversed
     * @param worker the function to be applied on each file that is not a directory
     * @param afterDir the function to be applied on the directory after traversing its children
     */
    private traversePathRecursively(path: string, worker: (filePath: string) => void, afterDirectory?: (filePath: string) => void) {
        if (!fs.existsSync(path)) {
            const msg = `Encountered a nonexistent path: ${path}`;
            if (this.logger) {this.logger.error(msg);}
            throw new Error(msg);
        }

        const fileStat = fs.lstatSync(path);
        if (fileStat.isFile()) {
            worker(path);
        } else if (fileStat.isDirectory()) {
            fs.readdirSync(path).forEach(nestedName => {
                const nestedPath = Path.join(path, nestedName);
                this.traversePathRecursively(nestedPath, worker, afterDirectory);
            });
    
            if (afterDirectory) {
                afterDirectory(path);
            }
        }
    }


    /**
     * Asserts that the number of keys of the provided object is expectedSize.
     * If not, logs an appropriate message (if log function provided) and throws an Error.
     * @param object the object to check
     * @param expectedSize the size that the object should have
     */
    private assertObjectSize(object: any, expectedSize: number) {
        let err = "";
        
        if (!object) {
            err = `Cannot assert for ${object}.`;
        } else {
            const objectSize = Object.keys(object).length;   
            if (objectSize !== expectedSize) {
                err = `Error in size assertion! Actual size: ${objectSize}. Expected size: ${expectedSize}.`;
            }
        }

        if (err) {
            if (this.logger) {
                this.logger.error({ loc: "[VALIDATION:SIZE_ASSERTION]" }, err);
            }
            throw new Error(err);
        }
    }

    /**
     * Hardhat build output can contain metadata and source files of every contract used in compilation.
     * Extracts these files from a given hardhat file following the hardhat output format.
     * 
     * @param hardhatFile 
     * @returns - {hardhatMetadataFiles, hardhatSourceFiles} 
     */
    private extractHardhatMetadataAndSources(hardhatFile: PathContent) {
        const hardhatMetadataFiles: any[] = [];
        const hardhatSourceFiles: PathContent[] = [];

        const hardhatJson = JSON.parse(hardhatFile.content);

        // Extract source files
        const hardhatSourceFilesObject = hardhatJson.input.sources;
        for (const path in hardhatSourceFilesObject) {
            if (hardhatSourceFilesObject[path].content) {
                hardhatSourceFiles.push({path: path, content: hardhatSourceFilesObject[path].content})
            }
        }

        // Extract metadata files
        const contractsObject = hardhatJson.output.contracts;
        for (const path in contractsObject) {
            for (const contractName in contractsObject[path]) {
                if(contractsObject[path][contractName].metadata) {
                    const metadataObj = this.extractMetadataFromString(contractsObject[path][contractName].metadata)
                    hardhatMetadataFiles.push(metadataObj)
                }
            }
        }
        return {hardhatMetadataFiles, hardhatSourceFiles}
    }

    pathContentArrayToStringMap(pathContentArr: PathContent[]) {
        const stringMapResult: StringMap = {};
        pathContentArr.forEach((elem, i) => {
            if (elem.path) {
                stringMapResult[elem.path] = elem.content;
            } else {
                stringMapResult[`path-${i}`] = elem.content;
            }
        })
        return stringMapResult;
    }
}