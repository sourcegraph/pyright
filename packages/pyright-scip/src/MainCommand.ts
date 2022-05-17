import { Command } from 'commander';
import packageJson from '../package.json';

export interface IndexOptions {
    project: string;
    projectName: string;
    projectVersion: string;
    snapshotDir: string;
    environment: string;
    dev: boolean;

    // nyi
    output: string;
    cwd: string;
    progressBar: boolean;
}

export interface SnapshotOptions extends IndexOptions {
    only: string;
}

export const DEFAULT_OUTPUT_FILE = 'dump.lsif-typed';

export function mainCommand(
    indexAction: (options: IndexOptions) => void,
    snapshotAction: (dir: string, options: SnapshotOptions) => void
): Command {
    const command = new Command();
    command.name('scip-python').version(packageJson.version).description('SCIP indexer for Python');

    command
        .command('index')
        .requiredOption('--project-name <name>', 'the name of the current project, pypi name if applicable')
        .option('--project-version <version>', 'the version of the current project, defaults to git revision')
        .option('--cwd <path>', 'the working directory', process.cwd())
        .option('--output <path>', 'path to the output file', DEFAULT_OUTPUT_FILE)
        .option('--environment <json-file>', 'the environment json file (experimental)')
        .option('--no-progress-bar', 'whether to disable the progress bar')
        .option('--snapshot-dir <path>', 'the directory to output a snapshot of the SCIP dump')
        .option('--dev', 'run in developer mode (experimental)', false)
        .action((parsedOptions) => {
            indexAction(parsedOptions as IndexOptions);
        });

    command
        .command('snapshot-dir')
        .argument('<path>', 'the directory containing `input` directories')
        .option('--only <name>', 'only generate snapshots for <name>')
        .option('--project-name <name>', 'the name of the current project, pypi name if applicable', 'snapshot-util')
        .option('--project-version <version>', 'the name of the current project, pypi name if applicable', '0.1')
        .option('--environment <json-file>', 'the environment json file (experimental)')
        .action((dir, parsedOptions) => {
            snapshotAction(dir, parsedOptions as SnapshotOptions);
        });

    return command;
}
