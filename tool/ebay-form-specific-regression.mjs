import assert from "node:assert/strict";
import { extractVerifiedMpnFromForm } from "../dist/service/ebay-form-specific.js";
const field = {name:"itemSpecificMPN",labelText:"MPN",value:"W10276397",visible:true,enabled:true};
assert.deepEqual(extractVerifiedMpnFromForm([field]),{ok:true,mpn:"W10276397"});
assert.equal(extractVerifiedMpnFromForm([{name:"search-box-attributesMPN",labelText:"",value:"",visible:false,enabled:true}]).reason,"VISIBLE_MPN_FIELD_NOT_UNIQUE");
assert.equal(extractVerifiedMpnFromForm([{...field,name:"search-box-attributesMPN"}]).reason,"VISIBLE_MPN_FIELD_NOT_UNIQUE");
assert.equal(extractVerifiedMpnFromForm([{...field,value:""}]).reason,"VISIBLE_MPN_VALUE_INVALID");
assert.equal(extractVerifiedMpnFromForm([field,field]).reason,"VISIBLE_MPN_FIELD_NOT_UNIQUE");
console.log("EBAY_FORM_SPECIFIC_REGRESSION_PASS");
