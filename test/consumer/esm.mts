import { Crabrix } from 'crabrix';
import { makeClient } from './commonjs.cjs';
const fromCommonJS: Crabrix = makeClient();
const fromESM: ReturnType<typeof makeClient> = new Crabrix();
fromCommonJS.close();
fromESM.close();
