/**
 * 
 * ## Set of utilities based on the [RDF Canonicalization and Hash specification](https://www.w3.org/TR/rdf-canon/), 
 * and its implementation in [rdfs-c14n](https://www.npmjs.com/package/rdfjs-c14n).
 * 
 * 
 * @author: Ivan Herman, <ivan@w3.org> (https://www.w3.org/People/Ivan/)
 * @license: W3C Software License <https://www.w3.org/Consortium/Legal/2002/copyright-software-20021231>
 * 
 * @packageDocumentation
 *
 */

import * as rdf        from '@rdfjs/types';
import { DatasetCore } from '@rdfjs/types';
import * as n3         from 'n3';
import { RDFC10 }      from 'rdfjs-c14n';


/** Shorthand for the input type used by rdfjs-c14n. */
export type Quads = Iterable<rdf.Quad>;

/**
 * Calculate Hash using SHA-256
 * @param input 
 * @returns 
 */
async function calculateHash(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);

    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return hashHex;
};


/**
 * Calculate the hash of an RDF Dataset.
 * 
 * @param dataset - The input dataset
 * @returns - The calculated hash
 */
async function hashDataset(dataset: Quads): Promise<string> {
    const rdfc10 = new RDFC10();
    // Generate the nquad representation of the canonical dataset
    const c14nResult: string = await rdfc10.canonicalize(dataset);
    // Hash the nquads
    return rdfc10.hash(c14nResult);
}


/**
 * A slight generalization of an [RDF Dataset](https://www.w3.org/TR/rdf11-concepts/#section-dataset): 
 * association of URLs with an RDF Graphs or Dataset. 
 * It may therefore include “sets” of RDF Datasets, or a collection of
 * RDF Graphs that are not “combined” into an RDF Dataset.
 * 
 * An RDF Dataset can be represented as a DatasetMap, provided that the “name” of all 
 * [named graphs](https://www.w3.org/TR/rdf11-concepts/#section-dataset)
 * are URL-s, i.e., not BNodes. 
 * The [default graph](https://www.w3.org/TR/rdf11-concepts/#section-dataset) is 
 * represented through a “fake” URL, whose value
 * is implementation dependent.
 */
export type DatasetMap = Map<string, DatasetCore>;

/** "Fake" URL used to represent the default graph within a Dataset Map. */
export const DEFAULT_GRAPH_ID = "$$";

/**
 * Creation of a {@link DatasetMap} for the origin: the dataset is “partitioned” into
 * separate graphs, each identified by the graph name.
 * 
 * @param origin - An [RDF Dataset](https://www.w3.org/TR/rdf11-concepts/#section-dataset)
 * @returns 
 */
export function createDatasetMap(origin: Quads): DatasetMap {
    const datasetMap: DatasetMap = new Map();

    for (const quad of origin) {
        const graph: rdf.Quad_Graph = quad.graph;
        if (graph.value === "") {
            if (!datasetMap.has(DEFAULT_GRAPH_ID)) {
                datasetMap.set(DEFAULT_GRAPH_ID, new n3.Store())
            };
            datasetMap.get(DEFAULT_GRAPH_ID)?.add(quad);
        } else {
            if (!datasetMap.has(graph.value)) {
                datasetMap.set(graph.value, new n3.Store());
            }
            datasetMap.get(graph.value)?.add(quad);
        }
    }
    return datasetMap;
}

/********************************************************************************************************* */
/*    Classes, types, and methods for the implementation of MerkleDatasets                                 */
/********************************************************************************************************* */

/**
 * Representation of a Merkle Dataset for a specific {@link DatasetMap}.
 */
export interface MerkleDataset {
    /** The corresponding {@link DatasetMap} */
    datasetMap: DatasetMap;

    /** 
     * Array of {@link Leaf} nodes at the "bottom" of the Merkle Tree; each corresponds to a Dataset in the Map. 
     * The order within the array follows the lexicographic order of the corresponding keys in 
     * `datasetMap`.
     */
    leafs: Leaf[];

    /**
     * The top Node of the Merkle Tree, generated for the `leafs` values.
     */
    tree: Node;

    /**
     * The MerkleDataset Hash value; null if it has not been calculated yet.
     */
    hash: string | null;
}

/**
 * Information about a specific node in the MerkleTree. Instances of this class are
 * used for debugging purposes.
 * 
 * For information.
 */
export interface NodeInfo {
    /** ID value of the parent node; "null" if it does not exist */
    parent:     string;

    /** Local hash of the node; "null" if not calculated yet */
    hash:       string;
    
    /** Whether the node value has changed since the last regeneration of the Tree */
    changed:    boolean;
    
    /** ID value of the left child node; "null" if it does not exist */
    leftChild:  string;
    
    /** ID value of the right child node; "null" if it does not exist */
    rightChild: string;
    
    /** 
     * ID value of the node. Usually this is just a number, used to differentiate
     * the nodes. Exceptions are leaf nodes, where the ID value is the URL used as key
     * in the corresponding DatasetMap in the {@link MerkleDataset}.
     */
    id:         string;
    
    /** Whether the node is a leaf node or not. */
    leaf:       boolean;
}

/**
 * Information of a "row", i.e, all nodes belonging to the same level. 
 * (Levels are numbered from the top, starting with zero.)
 * 
 * For information.
 */
export interface RowInfo {
    /** Level number */
    level: number;
    
    /** All nodes on that level, ordered from left to right. */
    nodes: NodeInfo[];
}

export type TreeInfo = RowInfo[];


/**
 * Decorator function to ensure that some methods are only invoked at top level
 */
// deno-lint-ignore no-explicit-any
function mustBeTop(originalMethod: any, context: ClassMethodDecoratorContext) {
    const name = String(context.name)
    // deno-lint-ignore no-explicit-any
    function replacementMethod(this: Node, ...args: any[]) {
        if (this.parent !== null) {
            throw `This method should be called from the top level (method: ${name})`
        }
        return originalMethod.call(this, ...args);
    }
    return replacementMethod;
}

/**
 * Single node in the Merkle Tree. 
 * 
 * The tree is binary: each node has maximally two children, i.e., `left` and `right`. Leaf nodes 
 * have no children; some nodes may only have a left child, when the next layer has 
 * an odd number of nodes.
 * 
 * It is a Merkle tree: each node stores a 'label', calculated by concatenating the
 * and hashing the labels of the two children's respective labels (if applicable).
 * If there is only a (left) child, the label is the hash of the only descendent’s label.
 * The labels for leaf nodes are the RDF Dataset Hashes of the graphs they represent.
 * 
 * The label of the top node is the hash value of the whole Merkle Tree. 
 * 
 * It is possible to display a series of information for the tree, by calling the 
 * {@link Node#treeInfo} method. This returns a separate ”Information Tree” that can be
 * used for information/debugging purposes. Strictly speaking, this information tree, and the
 * {@link Node#treeInfo} method, is not necessary for the core functionality, and is used for
 * debugging only. A number of methods and some class properties have been defined to make
 * this possible; these are marked by “for information”, and can be ignored for the usage
 * of the core functionality.
 */
export class Node { 
    parent:     Node | null;
    label:      string | null;
    changed:    boolean;
    leftChild:  Node | null;
    rightChild: Node | null;


    /**
     * A simple identifier value for a node. In general, this value is generated internally;
     * for {@link Leaf} nodes this is the URL of the corresponding RDF Graph/Dataset. 
     * 
     */
    id: string;

    /** 
     * Counter used to generate distinct id values for each node. 
     * 
     * For information.
     */
    private static counter: number = 0;

    /** 
     * All nodes of single layer collected to provide information about the tree;
     * this is only stored in the leftmost node. Used for debugging purposes.
     */
    siblings: Node[] = [];

    constructor(label: string | null, left: Node | null = null, right: Node | null = null) {
        this.parent      = null;
        this.leftChild   = left;
        this.rightChild  = right;
        this.label       = label;
        this.changed     = true;
        this.id          = `${Node.counter++}`;
    }

    /**
     * Calculate the label of the node: hashing the concatenation of the two
     * children's respective labels (if applicable).
     * If there is only a (left) child, the label is the hash of the only descendent's label.
     * 
     * The calculation only takes place if at least one of the children’s 
     * `changed` property `true`. Once the 
     * calculation is done, the local `changed` value is set to `true` and children’s nodes are set 
     * to `false`. This ensures that if a change happens in a leaf, only those labels are calculated that 
     * are really affected by the change.
     * 
     * Note that the "real" hash calculation is delegated to the
     * protected {@link Node#combinedHash} method. This means
     * that new subclasses of the {@link Node} class can be defined using a different hash algorithm.
     *
     */
    async calculateHash(): Promise<void> {
        // Checking whether this either a leaf node (in which case the hash value has to be set
        // externally) or a node on the right edge, which has only one child.
        // If the latter, that child's hash must be rehashed.
        if (this.rightChild === null) {
            if (this.leftChild === null) {
                this.changed = false;
            } else {
                // This node has only one descendent because it is at the rightmost edge
                const left: string = this.leftChild.label || "";
                this.label = await this.combinedHash(left, "");
                this.changed = this.leftChild.changed;
                this.leftChild.changed = false;
            }
        } else if (this.leftChild === null) {
            // This is, in fact, an error somewhere; 
            // it would mean only the left child is null
            throw new Error("There is a bug somewhere, left child is null and right is not...");
        } else { 
            // Calculate the new hash value, if necessary
            if (this.leftChild.changed || this.rightChild.changed) {
                // New hash has to be calculated
                const left: string  = this.leftChild.label  || "";
                const right: string = this.rightChild.label || "";
                this.label = await this.combinedHash(left, right);
                this.leftChild.changed = this.rightChild.changed = false;
                this.changed = true;
            }
        }
    }

    // ------------------------------------------- Tree data for users
    /**
     * Is the node the top of the Merkle Tree?
     * 
     * For information.
     */
    isTopNode(): boolean {
        return this.parent === null;
    }

    /**
     * The overall depth of the tree.
     * 
     * For information.
     */
    @mustBeTop
    depth(): number {
        let retval = 0;
        let child = this.leftChild
        while(child !== null) {
            retval += 1;
            child = child.leftChild;
        }
        return retval;
    }

    /**
     * The number of levels of the tree (i.e., `depth` + 1).
     * 
     * For information.
     */
    @mustBeTop
    levels(): number {
        return this.depth() + 1
    }

    /**
     * Array containing the value of all nodes at a specific level `l`. 
     * The array is from the "left" to the "right".
     * 
     * For information.
     */
    @mustBeTop
    level(l: number): string[] {
        if (this.siblings.length === 0) {
            this.calculateSiblings();
        }
       if (l > this.depth()) {
            return []
        } else if (l === 0) {
            return [`${this.label}`];
        } else {
            let index = 1;
            let child = this.leftChild;
            while(child !== null) {
                if (index === l) {
                    return child.siblings.map((t: Node): string => `${t.label}`);
                } else {
                    index += 1;
                    child = child.leftChild;
                }
            }
            return [];
        }
    }

    /**
     * Tree information method: the number of nodes (including the leafs) in the tree.
     * 
     * For information.
     */
    @mustBeTop
    nodes(): number {
        if (this.siblings.length === 0) {
            this.calculateSiblings();
        }
        let retval = 1;
        let child = this.leftChild;
        while(child != null) {
            retval += child.siblings.length;
            child = child.leftChild;
        }
        return retval;
    }

    /**
     * Overall information object for the tree.
     * 
     * For information.
     */
    @mustBeTop
    info(): TreeInfo {
        if (this.siblings.length === 0) {
            this.calculateSiblings();
        }
        return this.treeInfo();
    }

    /**
     * Calculate the hash for a node. It concatenates the two incoming value, and
     * calculates an SHA-256 hash value of the result, represented as a hexadecimal string.
     */
    // deno-lint-ignore require-await
    protected async combinedHash(left: string, right: string): Promise<string> {
        const toBeHashed = left + right;
        return calculateHash(toBeHashed);
    }

    /**
     * Information of the tree. It uses, essentially, the id values for the structural 
     * references (left, right, parent)
     * and turns the `null` values into a string "null"
     * 
     * For information. 
     */
    protected nodeInfo(): NodeInfo {
        return {
            parent:     `${this.parent?.id || null}`,
            hash:       `${this.label}`,
            changed:     this.changed,
            leftChild:  `${this.leftChild?.id || null}`,
            rightChild: `${this.rightChild?.id || null}`,
            id:         this.id,
            leaf:       false,
        };
    }

    /** Private methods are all related to the debug function, ie, to produce a decent output of the tree state */

    /**
     * Create a small array of the left and right children, or a single entry array if
     * there is no right child.
     * 
     */
    private getChildren(): Node[] {
        const retval: Node[] = [];
        if (this.leftChild !== null) {
            retval.push(this.leftChild);
            if (this.rightChild !== null) retval.push(this.rightChild);
        }
        return retval;
    }

    /**
     * Calculate the array of siblings for each layer below the current node; 
     * the reference is put into the leftmost node. Should be called on the top layer.
     * This is a recursive method, to be called on the top node.
     * 
     * For information.
     *  
     */
    private calculateSiblings() {
        const getRow = (): Node[] => {
            if (this.parent === null) {
                return [this];
            } else {
                return this.parent.siblings
                    .map((node: Node): Node[] => node.getChildren())
                    .reduce((finalValue: Node[], currentValue: Node[]): Node[] => [...finalValue, ...currentValue], []);
            }
        };
        this.siblings = getRow();
        let child = this.leftChild;
        while (child !== null) {
            child.calculateSiblings();
            child = child.leftChild;
        }
    }

    /**
     * Recursive function to generate the row information structure for each layer,
     * to be called on the top layer.
     * 
     * For information.
     * 
     * @param level - current level
     */
    private treeInfo(level: number = 0): TreeInfo {
        const myRow: RowInfo = {
            level: level,
            nodes: this.siblings.map((node: Node): NodeInfo => node.nodeInfo()),
        }
        if (this.leftChild !== null) {
            return [myRow, ...this.leftChild.treeInfo(level + 1)];
        } else {
            return [myRow];
        }
    }
}

/**
 * Class representing leaf nodes. The main distinction is that the id value 
 * is the URL referring to the corresponding RDF Graph or Dataset.
 * 
 */
export class Leaf extends Node {
    constructor(url: string, hash: string) {
        super(hash);
        this.id = url
    }

    /**
     * For information.
     */
    protected nodeInfo(): NodeInfo {
        const retval: NodeInfo = super.nodeInfo();
        retval.leaf = true;
        return retval;
    }
}


/**
 * Calculate a full Merkle Tree like structure starting with the leaf nodes: it generates
 * each layer and calculates (and stores) the intermediate hash values.
 * 
 * @throws - the `leafs` array is empty. 
 */
async function calculateTree(leafs: Leaf[]): Promise<Node> {
    // Internal cycle for one level to the upper
    const nextLayer = async (layer: Node[]): Promise<Node[]> => {
        const newLayer: Node[] = layer
            // Group the nodes into pairs to create the common parents
            // do not calculate the hash yet; those should be subject to a Promise.all
            .reduce<Node[]>((newNodes: Node[], currentNode: Node, currentIndex: number, orig: Node[]): Node[] => {
                if (currentIndex % 2 === 0) {
                    const left: Node = currentNode;
                    const right: Node = orig[currentIndex+1];
                    if (right === undefined) {
                        // There is an odd number of nodes here, i.e., there is no "right" child
                        if (left.parent === null) {
                            // This is a new layer
                            const newNode: Node = new Node(null, left, null);
                            left.parent = newNode;
                        }
                    } else {
                        if (left.parent === null || right.parent === null) {
                            const newNode: Node = new Node(null, left, right);
                            left.parent = right.parent = newNode;
                        } else if (left.parent !== right.parent) {
                            throw new Error("Left and right have different parents?");
                        }
                    }
                    newNodes.push(left.parent);
                }
                return newNodes;
            }, []); 

        
        // Store the row at its first element:
        // Create the new hash values in one Promise blow...
        await Promise.all(newLayer.map((node: Node): Promise<void> => node.calculateHash()));
        return newLayer;
    }

    if (leafs.length === 0) {
        throw new Error("No initial value for Tree calculation?")
    } else if( leafs.length === 1) {
        return leafs[0]
    } else {
        let currentLayer: Node[] = leafs;
        while (currentLayer.length > 1) {
            currentLayer = await nextLayer(currentLayer);
        }
        return currentLayer[0];
    }
}

/**
 * Create a Merkle Dataset:
 * 
 * 1. Create an array of leaf nodes using the lexicographic order of the `datasetMap` keys.
 * 2. Create a {@link Leaf} node for each key.
 * 3. Canonicalize and calculate the hash for each RDF Graph (or RDF Dataset) in the map.
 * 4. Set the label of each leaf node to the newly calculated hash value of the corresponding Graph.
 * 3. Build a Merkle Dataset.
 * 
 * @param datasetMap 
 * @returns 
 */
export async function createMerkleDataset(datasetMap: DatasetMap): Promise<MerkleDataset> {
    // the keys must be sorted and used accordingly
    const keys: string[] = [...datasetMap.keys()].sort();

    if (keys.length === 0) {
        throw new Error('Empty dataset!')
    }

    // Note that the []] is only there to make the TS compiler happy. We know all keys have an entry.
    const graphs: Quads[] = keys.map((key: string): Quads => datasetMap.get(key) || []);

    // Calculate the hashes
    const hashes: string[] = await Promise.all(graphs.map((graph: Quads): Promise<string> => hashDataset(graph)));

    // Construct the Leaf nodes of the Merkle Dataset
    const leafs: Leaf[] = keys.map((url: string, index: number): Leaf => new Leaf(url, hashes[index]));

    // There must be an even number of entries unless the array has only one element
    if (leafs.length === 1) {
        return {
            datasetMap, leafs, 
            tree : leafs[0],
            hash : hashes[0]
        }
    } else {
        const tree: Node = await calculateTree(leafs);
        return {
            datasetMap, leafs,
            tree,
            hash : tree.label,
        }
    }
}

/**
 * Update a Merkle Dataset. The keys contain the URLs for the RDF Graphs or Datasets in 
 * the Dataset Map that have changed.
 * 
 * 1. Recalculates the hashes for the datasets that are flagged as changed.
 * 2. Changes the values in the corresponding leaf nodes, setting their {@link Node#changed} flag to true.
 * 3. Re-generates the Merkle tree by calculating the changed hash values only.
 * 
 * @param mDataset - Merkle Dataset to be changed
 * @param keys - Array of URLs, referring the RDF Graphs (or Dataset) in the Merkle Dataset leafs that have been changed.
 * @returns 
 */
export async function updateMerkleDataset(mDataset: MerkleDataset, keys: string[]): Promise<MerkleDataset> {
    // To be on the safe side, we filter out keys that have no value in the dataset map
    const realKeys: string[] = keys.filter((key: string): boolean => mDataset.datasetMap.has(key));
    const hashes: string[] = await Promise.all(realKeys.map( (key: string): Promise<string> => {
        const dataset = mDataset.datasetMap.get(key);
        if (dataset !== undefined) {
            return hashDataset(dataset);
        } else {
            // This should not happen due to the definition of real keys, but something should
            // be put here to make the TS compiler happy...
            return Promise.resolve('');
        }
    }));

    // We have to amend the 'leaf' nodes where some changes occurred.
    realKeys.forEach((_key: string, index: number): void => {
        const newHash: string = hashes[index];
        const leaf: Leaf      = mDataset.leafs[index];
        if (newHash !== leaf.label) {
            leaf.label = newHash;
            leaf.changed = true;
        }
    });

    // Off we go with the recalculation of the tree:
    const tree: Node = await calculateTree(mDataset.leafs);
    return {
        datasetMap : mDataset.datasetMap,
        leafs : mDataset.leafs,
        tree,
        hash: tree.label,
    }
}
