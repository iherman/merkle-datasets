import * as rdf from        '@rdfjs/types';
import { DatasetCore } from '@rdfjs/types';
import * as ds from         '../mdataset.ts'
import * as n3 from         'n3';
import * as yaml from       'npm:yaml'
import { pipeline } from    'node:stream/promises';
import * as fs from         'node:fs';



const { namedNode, literal, quad } = n3.DataFactory;

export type Quads = Iterable<rdf.Quad>;

async function get_quads(fname: string): Promise<Iterable<rdf.Quad>> {
    const trigStream = fs.createReadStream(fname, 'utf-8');
    const store = new n3.Store();
    const parser = new n3.StreamParser({ blankNodePrefix: '' });
    store.import(parser);
    await pipeline(trigStream, parser);
    return store;
}


// The real tests start here

const dataset: Iterable<rdf.Quad> = await get_quads("./tests/turtle_ex.ttl");
// Create a Merkle Dataset
const datasetMap = ds.createDatasetMap(dataset);
const merkleDs: ds.MerkleDataset = await ds.createMerkleDataset(datasetMap);

// Dump the full dataset, using the built-in logging info
console.log(yaml.stringify(merkleDs.tree.info()));

// Query some data in the tree
console.log(`Depth: ${merkleDs.tree.depth()}`);
console.log(`Number of nodes: ${merkleDs.tree.nodes()}`);
console.log(`Level 3 hashes:`);
console.log(merkleDs.tree.level(2));


// odifying one of the datasets and recalculate the merkle dataset
const defaultGraph: DatasetCore | undefined = datasetMap.get(ds.DEFAULT_GRAPH_ID);

const sztaki = namedNode("https://www.sztaki.hu");
const prop = namedNode("http://example.org");
const val = literal("something");

if (defaultGraph !== undefined) {
    defaultGraph.add(quad(sztaki, prop, val));
    const ms2: ds.MerkleDataset = await ds.updateMerkleDataset(merkleDs, [ds.DEFAULT_GRAPH_ID]);
    console.log("\n---- Default graph has changed")
    console.log(yaml.stringify(ms2.tree.info()));
} else {
    console.log("????? This should not happen in the test case, there is a default graph in the turtle file...")
}

